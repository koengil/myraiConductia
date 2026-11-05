import { execFileSync } from "node:child_process";

export type Environment = Record<string, string | undefined>;

export type DatabaseTarget = {
  host: string;
  port: string;
  user?: string;
  database: string;
  password?: string;
};

export type PsqlInvocation<T extends Environment> = { args: string[]; env: T };

const DATABASE_URL_PATTERN =
  /^postgres(?:ql)?:\/\/(?:([A-Za-z0-9_]+)(?::((?:[A-Za-z0-9_.~-]|%[0-9A-Fa-f]{2})*))?@)?(localhost|127\.0\.0\.1|\[::1\]|postgres)(?::([0-9]{1,5}))?\/([A-Za-z0-9_]+)$/;
const VALIDATED_TARGETS = new WeakSet<DatabaseTarget>();

function refuse(reason: string): never {
  throw new Error(`Refusing DATABASE_URL: ${reason}`);
}

function validatedPort(port: string | undefined): string {
  if (port === undefined) return "5432";
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    refuse("the port must be between 1 and 65535.");
  }
  return String(value);
}

function decodedPassword(password: string | undefined): string | undefined {
  if (!password) return undefined;
  try {
    return decodeURIComponent(password);
  } catch {
    return refuse("the password encoding is invalid.");
  }
}

export function assertLocalDatabaseUrl(
  url: string,
  env: Environment = process.env,
): DatabaseTarget {
  const match = DATABASE_URL_PATTERN.exec(url);
  if (!match) {
    refuse(
      "expected postgres[ql]://[user[:password]@]host[:port]/database with a local host and no query or fragment.",
    );
  }
  const [, user, password, host, port, database] = match;
  if (host === "postgres" && env.ALLOW_LOCAL_DB_HOST !== "postgres") {
    refuse("the postgres host requires ALLOW_LOCAL_DB_HOST=postgres.");
  }
  const target: DatabaseTarget = {
    host: host === "[::1]" ? "::1" : host,
    port: validatedPort(port),
    database,
  };
  if (user) target.user = user;
  const decoded = decodedPassword(password);
  if (decoded) target.password = decoded;
  VALIDATED_TARGETS.add(target);
  return target;
}

export function requireLocalDatabase(
  env: Environment = process.env,
): DatabaseTarget {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required when RUN_DB_TESTS=1");
  return assertLocalDatabaseUrl(url, env);
}

export function psqlInvocation<T extends Environment>(
  target: DatabaseTarget,
  args: string[],
  env: T,
): PsqlInvocation<T> {
  const childEnv: Environment = Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("PG")),
  );
  if (target.password) childEnv.PGPASSWORD = target.password;
  const user = target.user ? ["-U", target.user] : [];
  return {
    args: [
      "-X",
      "-h",
      target.host,
      "-p",
      target.port,
      ...user,
      "-d",
      target.database,
      ...args,
    ],
    env: childEnv as T,
  };
}

function psqlFailure(target: DatabaseTarget, error: unknown): string {
  const stderr =
    error !== null && typeof error === "object" && "stderr" in error
      ? String(error.stderr ?? "")
      : "";
  const detail = target.password
    ? stderr.split(target.password).join("[redacted]").trim()
    : stderr.trim();
  const location = `${target.host}:${target.port}/${target.database}`;
  return `psql failed against ${location}${detail ? `: ${detail}` : "."}`;
}

export function runPsql(
  target: DatabaseTarget,
  args: string[],
  input?: string,
): string {
  if (!VALIDATED_TARGETS.has(target)) {
    refuse("the target was not produced by the local database guard.");
  }
  const invocation = psqlInvocation(target, args, process.env);
  try {
    return execFileSync("psql", invocation.args, {
      input,
      encoding: "utf8",
      stdio: "pipe",
      env: invocation.env,
    });
  } catch (error) {
    throw new Error(psqlFailure(target, error));
  }
}
