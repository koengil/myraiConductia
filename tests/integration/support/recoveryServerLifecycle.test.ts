import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  drainStderr,
  stopChild,
  waitForPortOrKill,
  type GroupKill,
  type SpawnedChild,
} from "./recoveryServer";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 999_999;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  simulateExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function asSpawnedChild(fake: FakeChild): SpawnedChild {
  return fake as unknown as SpawnedChild;
}

function recordingGroupKill(
  fake: FakeChild,
  calls: NodeJS.Signals[],
): GroupKill {
  return (_child, signal) => {
    calls.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => fake.simulateExit(null, "SIGKILL"));
    }
  };
}

async function killsChildOnPortWaitTimeout(): Promise<void> {
  const fake = new FakeChild();
  const child = asSpawnedChild(fake);
  const stderr = drainStderr(fake.stderr);
  const calls: NodeJS.Signals[] = [];

  await expect(
    waitForPortOrKill(child, stderr, 15, 15, recordingGroupKill(fake, calls)),
  ).rejects.toThrow(/did not report a port/);

  expect(calls).toContain("SIGTERM");
}

async function rejectsOnEarlyExit(): Promise<void> {
  const fake = new FakeChild();
  const child = asSpawnedChild(fake);
  const stderr = drainStderr(fake.stderr);
  const calls: NodeJS.Signals[] = [];

  const pending = waitForPortOrKill(
    child,
    stderr,
    5_000,
    5_000,
    recordingGroupKill(fake, calls),
  );
  fake.simulateExit(1, null);

  await expect(pending).rejects.toThrow(/exited before reporting a port/);
  expect(calls).toHaveLength(0);
}

async function resolvesImmediatelyWhenAlreadyExited(): Promise<void> {
  const fake = new FakeChild();
  fake.exitCode = 0;
  const child = asSpawnedChild(fake);
  const calls: NodeJS.Signals[] = [];

  await stopChild(child, 5_000, recordingGroupKill(fake, calls));

  expect(calls).toHaveLength(0);
}

async function escalatesToSigkill(): Promise<void> {
  const fake = new FakeChild();
  const child = asSpawnedChild(fake);
  const calls: NodeJS.Signals[] = [];

  await stopChild(child, 15, recordingGroupKill(fake, calls));

  expect(calls).toEqual(["SIGTERM", "SIGKILL"]);
}

describe("publication e2e server lifecycle helpers", () => {
  it(
    "kills the child when the port wait times out",
    killsChildOnPortWaitTimeout,
  );
  it(
    "rejects when the child exits before reporting a port",
    rejectsOnEarlyExit,
  );
  it(
    "resolves immediately when the child has already exited",
    resolvesImmediatelyWhenAlreadyExited,
  );
  it(
    "escalates from SIGTERM to SIGKILL when the child ignores the grace period",
    escalatesToSigkill,
  );
});
