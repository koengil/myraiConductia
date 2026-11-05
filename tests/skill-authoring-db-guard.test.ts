import { describe, expect, it } from "vitest";
import {
  assertLocalDatabaseUrl,
  psqlInvocation,
  runPsql,
  type Environment,
} from "./db/localDatabase";

const SOCKET = "%2Fnonexistent-probe-socket-dir";
const LOOPBACK = "postgresql://postgres@127.0.0.1:55439/ignatious_platform";
const COMPOSE = "postgresql://postgres@postgres:5432/ignatious_platform";
const SECRET_URL =
  "postgresql://probe_user:leaky-secret@127.0.0.1:55439/ignatious_platform";

const REJECTED: Array<[string, string, Environment]> = [
  [
    "the first confirmed query-@ bypass",
    `postgresql://127.0.0.1:55439?sslmode=disable@${SOCKET}:55439/ignatious_platform`,
    {},
  ],
  [
    "the second confirmed query-@ bypass",
    `postgresql://127.0.0.1?application_name=x@${SOCKET}`,
    {},
  ],
  [
    "a query-@ bypass from [::1]",
    `postgresql://[::1]:55439?sslmode=disable@${SOCKET}:55439/ignatious_platform`,
    {},
  ],
  [
    "a query-@ bypass from localhost",
    `postgresql://localhost:55439?sslmode=disable@${SOCKET}:55439/ignatious_platform`,
    {},
  ],
  [
    "a query-@ bypass into a comma multi-host",
    `postgresql://127.0.0.1?sslmode=disable@${SOCKET}:55439,${SOCKET}-2:55439/x`,
    {},
  ],
  [
    "a query-@ bypass naming a hosted host",
    "postgresql://127.0.0.1?sslmode=disable@db.example.com/x",
    {},
  ],
  ["any query string", `${LOOPBACK}?sslmode=disable`, {}],
  ["a host query", `${LOOPBACK}?host=${SOCKET}`, {}],
  ["any fragment", `${LOOPBACK}#fragment`, {}],
  ["a fragment hiding a host query", `${LOOPBACK}#?host=${SOCKET}`, {}],
  [
    "a database name outside the allowed characters",
    "postgresql://postgres@127.0.0.1:55439/ignatious-platform",
    {},
  ],
  [
    "a conninfo-shaped database name",
    `postgresql://postgres@127.0.0.1:55439/host%3D${SOCKET}`,
    {},
  ],
  [
    "a user outside the allowed characters",
    "postgresql://probe-user@127.0.0.1:55439/ignatious_platform",
    {},
  ],
  ["a missing database name", "postgresql://postgres@127.0.0.1:55439/", {}],
  ["an uppercase scheme", "POSTGRESQL://postgres@127.0.0.1:55439/x", {}],
  ["a non-numeric port", "postgresql://postgres@127.0.0.1:port/x", {}],
  ["an out-of-range port", "postgresql://postgres@127.0.0.1:99999/x", {}],
  ["a multi-host authority", "postgresql://postgres@127.0.0.1,localhost/x", {}],
  ["a second user-info separator", "postgresql://a@b@127.0.0.1:55439/x", {}],
  ["a non-loopback hostname", "postgresql://postgres@hosted.invalid/x", {}],
  ["a non-postgres scheme", "mysql://postgres@127.0.0.1:55439/x", {}],
  ["the compose host without opt-in", COMPOSE, {}],
  [
    "the compose host with another opt-in",
    COMPOSE,
    { ALLOW_LOCAL_DB_HOST: "db" },
  ],
  ["an unparsable URL", "not a database url", {}],
];

const LEAKY_REFUSALS = [
  "postgresql://leaky_user:leaky-secret@hosted.invalid:5432/postgres",
  `postgresql://leaky_user:leaky-secret@127.0.0.1?sslmode=disable@${SOCKET}/x`,
];

const ACCEPTED: Array<[string, string, Environment, Record<string, string>]> = [
  [
    "the plain loopback URL",
    LOOPBACK,
    {},
    {
      host: "127.0.0.1",
      port: "55439",
      user: "postgres",
      database: "ignatious_platform",
    },
  ],
  [
    "bracketed IPv6 loopback with the default port",
    "postgresql://postgres@[::1]/ignatious_platform",
    {},
    {
      host: "::1",
      port: "5432",
      user: "postgres",
      database: "ignatious_platform",
    },
  ],
  [
    "a percent-encoded password",
    "postgres://postgres:p%40ss%2Fword@localhost:55439/ignatious_platform",
    {},
    {
      host: "localhost",
      port: "55439",
      user: "postgres",
      database: "ignatious_platform",
      password: "p@ss/word",
    },
  ],
  [
    "the postgres compose host when opted in",
    COMPOSE,
    { ALLOW_LOCAL_DB_HOST: "postgres" },
    {
      host: "postgres",
      port: "5432",
      user: "postgres",
      database: "ignatious_platform",
    },
  ],
];

const DIRTY_ENV: Environment = {
  PATH: "/usr/bin",
  PGHOST: "/nonexistent-probe-socket-dir",
  PGHOSTADDR: "127.0.0.2",
  PGSERVICE: "nonexistent-probe-service",
  PGSERVICEFILE: "/nonexistent-probe-service-file",
  PGPORT: "5433",
  PGUSER: "other",
  PGDATABASE: "other",
  PGPASSWORD: "stale-password",
  PGSSLMODE: "require",
  PGOPTIONS: "-c statement_timeout=1",
};

const EXPECTED_ARGS = [
  "-X",
  "-h",
  "127.0.0.1",
  "-p",
  "55439",
  "-U",
  "probe_user",
  "-d",
  "ignatious_platform",
  "-Atc",
  "select 1",
];

function refusal(url: string, env: Environment = {}): string {
  try {
    assertLocalDatabaseUrl(url, env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "accepted";
}

function psqlFailureMessage(): string {
  try {
    runPsql(assertLocalDatabaseUrl(SECRET_URL, {}), [
      "--nonexistent-probe-option",
    ]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "psql did not fail";
}

describe("skill authoring database guard refusals", () => {
  it.each(REJECTED)("rejects %s", (_label, url, env) => {
    expect(refusal(url, env)).toMatch(/^Refusing /);
  });

  it.each(LEAKY_REFUSALS)(
    "keeps the URL and credentials out of refusal %#",
    (url) => {
      const message = refusal(url);
      expect(message).toMatch(/^Refusing /);
      expect(message).not.toMatch(/leaky-secret|leaky_user|postgresql:\/\//);
    },
  );
});

describe("skill authoring database guard acceptance", () => {
  it.each(ACCEPTED)("accepts %s", (_label, url, env, expected) => {
    expect(assertLocalDatabaseUrl(url, env)).toEqual(expected);
  });
});

describe("skill authoring psql invocation", () => {
  it("builds argv from validated components without the URL or password", () => {
    const target = assertLocalDatabaseUrl(SECRET_URL, {});
    const invocation = psqlInvocation(target, ["-Atc", "select 1"], DIRTY_ENV);
    expect(invocation.args).toEqual(EXPECTED_ARGS);
    expect(invocation.args.join(" ")).not.toMatch(/leaky-secret|postgresql:/);
    expect(invocation.env).toEqual({
      PATH: "/usr/bin",
      PGPASSWORD: "leaky-secret",
    });
  });

  it("omits PGPASSWORD when the URL has no password", () => {
    const target = assertLocalDatabaseUrl(LOOPBACK, {});
    expect(psqlInvocation(target, [], DIRTY_ENV).env).toEqual({
      PATH: "/usr/bin",
    });
  });
});

describe("skill authoring psql failures", () => {
  it("surfaces a psql failure without the URL or password", () => {
    const message = psqlFailureMessage();
    expect(message).toMatch(
      /^psql failed against 127\.0\.0\.1:55439\/ignatious_platform/,
    );
    expect(message).not.toMatch(/leaky-secret|postgresql:\/\//);
  });

  it("refuses a target that the guard did not produce", () => {
    const forged = {
      host: "/nonexistent-probe-socket-dir",
      port: "55439",
      user: "postgres",
      database: "ignatious_platform",
    };
    expect(() => runPsql(forged, ["-Atc", "select 1"])).toThrow(/^Refusing /);
  });
});
