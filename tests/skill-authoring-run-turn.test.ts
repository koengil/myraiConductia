import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERATION_FAILED,
  GENERATION_FAILED_MESSAGE,
  KEEPALIVE_MS,
  PROGRESS_FLUSH_MS,
  runAuthoringTurn,
  type RunTurnDeps,
} from "@/lib/skillAuthoring/runTurn";
import type {
  TurnLine,
  TurnRequest,
} from "@/lib/skillAuthoring/ignatiousAuthoring";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

const TURN_REQUEST: TurnRequest = {
  attemptId: ATTEMPT_ID,
  history: [],
  message: "draft a buyer outreach tracker",
  currentCandidate: null,
  basis: null,
  seedRun: null,
};

const CONTRACT_CANDIDATE = {
  providerCandidateId: "6a1f2c9e-3b7d-5e10-8c4a-2f9b1d7e6a53",
  contentDigest:
    "66d2f3cda3148430b408c141dd7c6d644b11b543f280db363611ea88e03f22da",
  schemaVersion: 1 as const,
  preview: {
    name: "buyer-outreach-tracker",
    purpose: "Track buyer outreach",
    expectedInput: "Buyer list",
    expectedOutput: "Outreach table",
    inputs: [],
  },
};

const CONTRACT_LINES: TurnLine[] = [
  { type: "text", text: "Here is a draft " },
  { type: "text", text: "for the buyer tracker." },
  { type: "candidate", ...CONTRACT_CANDIDATE },
  { type: "done" },
];

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function fakeRpc(responses: Record<string, unknown>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    calls.push([fn, args]);
    return fn in responses ? responses[fn] : true;
  };
  return { rpc, calls };
}

function linesAdvancing(
  clock: ReturnType<typeof fakeClock>,
  lines: TurnLine[],
  stepMs: number,
) {
  return async function* (
    _request: TurnRequest,
    _signal: AbortSignal,
  ): AsyncGenerator<TurnLine> {
    for (const line of lines) {
      clock.advance(stepMs);
      yield line;
    }
  };
}

describe("runAuthoringTurn", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes progress once the cadence reaches exactly the 500ms boundary", async () => {
    const clock = fakeClock();
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    const lines: TurnLine[] = [
      { type: "text", text: "partial" },
      { type: "done" },
    ];
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: linesAdvancing(clock, lines, PROGRESS_FLUSH_MS),
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
      now: clock.now,
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls).toContainEqual([
      "skill_authoring_record_progress",
      { p_attempt_id: ATTEMPT_ID, p_text: "partial" },
    ]);
  });

  it("flushes progress on the keep-alive interval when no new text has arrived", async () => {
    vi.useFakeTimers();
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    let releaseStream: () => void = () => undefined;
    const stalled = new Promise<void>((resolvePromise) => {
      releaseStream = resolvePromise;
    });
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: async function* () {
        yield { type: "text", text: "partial" } as TurnLine;
        await stalled;
        yield { type: "done" } as TurnLine;
      },
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
    };

    const turn = runAuthoringTurn(ATTEMPT_ID, deps);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);

    expect(
      rpc.calls.some(([fn]) => fn === "skill_authoring_record_progress"),
    ).toBe(true);

    releaseStream();
    await turn;
  });

  it("streams progress, then completes with the full text and the last candidate", async () => {
    const clock = fakeClock();
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: linesAdvancing(clock, CONTRACT_LINES, 600),
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
      now: clock.now,
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls).toContainEqual([
      "skill_authoring_record_progress",
      { p_attempt_id: ATTEMPT_ID, p_text: "Here is a draft " },
    ]);
    expect(rpc.calls.at(-1)).toEqual([
      "skill_authoring_complete_attempt",
      {
        p_attempt_id: ATTEMPT_ID,
        p_text: "Here is a draft for the buyer tracker.",
        p_candidate: CONTRACT_CANDIDATE,
      },
    ]);
  });

  it("keeps the streamed reply when the candidate fails validation", async () => {
    const clock = fakeClock();
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    const lines: TurnLine[] = [
      { type: "text", text: "Here is a draft." },
      {
        type: "candidate",
        ...CONTRACT_CANDIDATE,
        providerCandidateId: "not-a-uuid",
      },
      { type: "done" },
    ];
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: linesAdvancing(clock, lines, 600),
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
      now: clock.now,
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls.at(-1)).toEqual([
      "skill_authoring_complete_attempt",
      {
        p_attempt_id: ATTEMPT_ID,
        p_text: "Here is a draft.",
        p_candidate: null,
      },
    ]);
  });

  it("fails the attempt with the error line code and message", async () => {
    const clock = fakeClock();
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    const lines: TurnLine[] = [
      { type: "text", text: "partial" },
      {
        type: "error",
        code: "generation_failed",
        message: "Generation could not complete. Try again.",
      },
    ];
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: linesAdvancing(clock, lines, 100),
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
      now: clock.now,
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls.at(-1)).toEqual([
      "skill_authoring_fail_attempt",
      {
        p_attempt_id: ATTEMPT_ID,
        p_code: "generation_failed",
        p_message: "Generation could not complete. Try again.",
      },
    ]);
    expect(
      rpc.calls.some(([fn]) => fn === "skill_authoring_complete_attempt"),
    ).toBe(false);
  });

  it("fails the attempt when the stream ends without a terminal line", async () => {
    const clock = fakeClock();
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    const lines: TurnLine[] = [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ];
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: linesAdvancing(clock, lines, 100),
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
      now: clock.now,
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls.at(-1)).toEqual([
      "skill_authoring_fail_attempt",
      {
        p_attempt_id: ATTEMPT_ID,
        p_code: GENERATION_FAILED,
        p_message: GENERATION_FAILED_MESSAGE,
      },
    ]);
  });

  it("fails the attempt when the stream throws", async () => {
    const clock = fakeClock();
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: async function* () {
        clock.advance(100);
        yield { type: "text", text: "one" } as TurnLine;
        throw new Error("stream failed");
      },
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
      now: clock.now,
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls.at(-1)).toEqual([
      "skill_authoring_fail_attempt",
      {
        p_attempt_id: ATTEMPT_ID,
        p_code: GENERATION_FAILED,
        p_message: GENERATION_FAILED_MESSAGE,
      },
    ]);
  });

  it("fails the attempt when the deadline aborts the stream", async () => {
    const rpc = fakeRpc({ skill_authoring_run_context: TURN_REQUEST });
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: async function* (_request: TurnRequest, signal: AbortSignal) {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          signal.addEventListener("abort", () =>
            rejectPromise(new Error("aborted")),
          );
        });
        yield { type: "done" } as TurnLine;
      },
      deadlineMs: 5,
      projectId: "44444444-4444-4444-8444-444444444444",
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls.at(-1)).toEqual([
      "skill_authoring_fail_attempt",
      {
        p_attempt_id: ATTEMPT_ID,
        p_code: GENERATION_FAILED,
        p_message: GENERATION_FAILED_MESSAGE,
      },
    ]);
  });

  it("does nothing when the attempt is no longer running", async () => {
    const rpc = fakeRpc({ skill_authoring_run_context: null });
    const deps: RunTurnDeps = {
      rpc: rpc.rpc,
      stream: async function* () {
        throw new Error("must not be called");
      },
      deadlineMs: 50_000,
      projectId: "44444444-4444-4444-8444-444444444444",
    };

    await runAuthoringTurn(ATTEMPT_ID, deps);

    expect(rpc.calls).toHaveLength(1);
  });

  describe("the AI cost ledger (agents-backend PR #147 prices the done line)", () => {
    const priced: TurnLine[] = [
      { type: "text", text: "Here is a draft." },
      { type: "done", costUsd: 0.0421, model: "sonnet", modelId: "anthropic/claude-sonnet-5" },
    ];

    function depsWith(lines: TurnLine[], context: TurnRequest = TURN_REQUEST) {
      const clock = fakeClock();
      const rpc = fakeRpc({ skill_authoring_run_context: context });
      const record = vi.fn(async () => undefined);
      const deps: RunTurnDeps = {
        rpc: rpc.rpc,
        stream: linesAdvancing(clock, lines, 100),
        deadlineMs: 50_000,
        projectId: "44444444-4444-4444-8444-444444444444",
        now: clock.now,
        record,
      };
      return { deps, record, rpc };
    }

    it("records a finished authoring turn once, after it completes, under the bare model id", async () => {
      const { deps, record, rpc } = depsWith(priced);
      await runAuthoringTurn(ATTEMPT_ID, deps);
      expect(rpc.calls.at(-1)?.[0]).toBe("skill_authoring_complete_attempt");
      expect(record).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledWith(ATTEMPT_ID, "skill_authoring", {
        model: "claude-sonnet-5",
        costUsd: 0.0421,
      });
    });

    it("names a turn seeded from an existing skill an enhancement", async () => {
      const basis = { kind: "catalog", skillId: "s-1", version: "1.0.0", digest: "d" } as unknown as TurnRequest["basis"];
      const { deps, record } = depsWith(priced, { ...TURN_REQUEST, basis });
      await runAuthoringTurn(ATTEMPT_ID, deps);
      expect(record).toHaveBeenCalledWith(ATTEMPT_ID, "skill_enhancement", expect.anything());
    });

    it("records an unpriced turn with a null cost, never zero", async () => {
      const { deps, record } = depsWith([{ type: "done", costUsd: null, model: null, modelId: null }]);
      await runAuthoringTurn(ATTEMPT_ID, deps);
      expect(record).toHaveBeenCalledWith(ATTEMPT_ID, "skill_authoring", { model: null, costUsd: null });
    });

    it("records nothing for a failed turn", async () => {
      const { deps, record } = depsWith([{ type: "error", code: "generation_failed", message: "x" }]);
      await runAuthoringTurn(ATTEMPT_ID, deps);
      expect(record).not.toHaveBeenCalled();
    });
  });
});
