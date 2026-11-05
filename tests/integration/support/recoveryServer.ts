import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const PORT_LINE = /^PUBLICATION_E2E_PORT=(\d+)$/m;
const BOOT_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const STDERR_BUFFER_LIMIT = 4_000;

export type SpawnedChild = ChildProcessByStdio<null, Readable, Readable>;

export type RecoveryServer = {
  baseUrl: string;
  pid: number | undefined;
  stop(): Promise<void>;
};

export type GroupKill = (child: SpawnedChild, signal: NodeJS.Signals) => void;

export type StderrBuffer = { get(): string };

export function ignatiousPlatformDir(): string {
  const repo = process.env.IGNATIOUS_REPO;
  if (!repo)
    throw new Error("IGNATIOUS_REPO must be set for the recovery suite");
  return `${repo}/platform`;
}

export function assertRecoveryDatabaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("SKILL_BENCH_DATABASE_URL must be a postgres URL");
  }
  if (!["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) {
    throw new Error("SKILL_BENCH_DATABASE_URL must be a loopback host");
  }
  if (parsed.port !== "55439") {
    throw new Error(
      "SKILL_BENCH_DATABASE_URL must use port 55439, never 54322",
    );
  }
  return value;
}

export function drainStderr(
  stream: Readable,
  limit = STDERR_BUFFER_LIMIT,
): StderrBuffer {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > limit) buffer = buffer.slice(buffer.length - limit);
  });
  return { get: () => buffer };
}

function hasExited(child: SpawnedChild): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

type Settle = (fn: () => void) => void;

function timeoutError(timeoutMs: number, stderr: StderrBuffer): Error {
  return new Error(
    `publication e2e server did not report a port within ${timeoutMs}ms; stderr: ${stderr.get()}`,
  );
}

function exitError(
  code: number | null,
  signal: string | null,
  stderr: StderrBuffer,
): Error {
  return new Error(
    `publication e2e server exited before reporting a port (code ${code}, signal ${signal}); stderr: ${stderr.get()}`,
  );
}

function attachPortWatchers(
  child: SpawnedChild,
  stderr: StderrBuffer,
  settle: Settle,
  resolve: (port: number) => void,
  reject: (error: Error) => void,
): void {
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const match = PORT_LINE.exec(buffer);
    if (match) settle(() => resolve(Number(match[1])));
  });
  child.once("error", (error) => settle(() => reject(error)));
  child.once("exit", (code, signal) =>
    settle(() => reject(exitError(code, signal, stderr))),
  );
}

export function waitForPort(
  child: SpawnedChild,
  stderr: StderrBuffer,
  timeoutMs = BOOT_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle: Settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(timeoutError(timeoutMs, stderr))),
      timeoutMs,
    );
    attachPortWatchers(child, stderr, settle, resolve, reject);
  });
}

export function defaultGroupKill(
  child: SpawnedChild,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function stopChild(
  child: SpawnedChild,
  graceMs = STOP_GRACE_MS,
  groupKill: GroupKill = defaultGroupKill,
): Promise<void> {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once("exit", finish);
    const killTimer = setTimeout(() => groupKill(child, "SIGKILL"), graceMs);
    groupKill(child, "SIGTERM");
  });
}

export async function waitForPortOrKill(
  child: SpawnedChild,
  stderr: StderrBuffer,
  timeoutMs = BOOT_TIMEOUT_MS,
  graceMs = STOP_GRACE_MS,
  groupKill: GroupKill = defaultGroupKill,
): Promise<number> {
  try {
    return await waitForPort(child, stderr, timeoutMs);
  } catch (error) {
    await stopChild(child, graceMs, groupKill);
    throw error;
  }
}

function spawnEntry(databaseUrl: string): SpawnedChild {
  return spawn(
    "pnpm",
    [
      "--filter",
      "@ignatious/skill-bench",
      "exec",
      "tsx",
      "src/authoring/publication/e2e-server-entry.ts",
    ],
    {
      cwd: ignatiousPlatformDir(),
      env: { ...process.env, SKILL_BENCH_DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
}

export async function startPublicationE2EServer(): Promise<RecoveryServer> {
  const rawDatabaseUrl = process.env.SKILL_BENCH_DATABASE_URL;
  if (!rawDatabaseUrl) {
    throw new Error(
      "SKILL_BENCH_DATABASE_URL must be set for the recovery suite",
    );
  }
  const databaseUrl = assertRecoveryDatabaseUrl(rawDatabaseUrl);
  const child = spawnEntry(databaseUrl);
  const stderr = drainStderr(child.stderr);
  const port = await waitForPortOrKill(child, stderr);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pid: child.pid,
    stop: () => stopChild(child),
  };
}

const GUARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

export function installShutdownGuard(server: RecoveryServer): () => void {
  if (server.pid === undefined) return () => {};
  const pid = server.pid;
  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    for (const signal of GUARDED_SIGNALS) {
      process.removeListener(signal, handler);
    }
  };
  function handler(signal: NodeJS.Signals): void {
    remove();
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    process.kill(process.pid, signal);
  }
  for (const signal of GUARDED_SIGNALS) {
    process.on(signal, handler);
  }
  return remove;
}
