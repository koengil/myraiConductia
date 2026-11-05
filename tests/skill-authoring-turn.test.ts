import { expect, it } from "vitest";
import { runAuthoringTurn, type RunTurnDeps } from "@/lib/skillAuthoring/runTurn";
import type { TurnLine, TurnRequest } from "@/lib/skillAuthoring/ignatiousAuthoring";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const DEAL_ID = "44444444-4444-4444-8444-444444444444";

const BINDING = {
  skillId: "22222222-2222-4222-8222-222222222222",
  versionId: "33333333-3333-4333-8333-333333333333",
  digest: "b".repeat(64),
};

const BASE_CONTEXT_FIELDS = {
  attemptId: ATTEMPT_ID,
  history: [],
  message: "improve the buyer outreach tracker",
  currentCandidate: null,
};

async function captureTurnRequest(context: unknown): Promise<TurnRequest> {
  let sent: TurnRequest | null = null;
  const deps: RunTurnDeps = {
    rpc: async (fn) => {
      if (fn === "skill_authoring_run_context") return context;
      return true;
    },
    stream: async function* (request: TurnRequest, _signal: AbortSignal) {
      sent = request;
      yield { type: "done" } as TurnLine;
    },
    deadlineMs: 50_000,
    projectId: DEAL_ID,
  };
  await runAuthoringTurn(ATTEMPT_ID, deps);
  if (!sent) throw new Error("stream was never called");
  return sent;
}

it("sends the basis and the seed run for an enhancement draft", async () => {
  const sent = await captureTurnRequest({
    ...BASE_CONTEXT_FIELDS,
    basis: { kind: "publication", ...BINDING },
    seedRun: { input: "Check Acme", output: "High confidence." },
  });

  expect(sent).toMatchObject({
    basis: { kind: "publication", projectId: DEAL_ID, ...BINDING },
    seedRun: { input: "Check Acme", output: "High confidence." },
  });
});

it("sends a mount basis without a projectId", async () => {
  const mount = { kind: "mount", name: "md-briefing", version: 3, digest: "f".repeat(64) };
  const sent = await captureTurnRequest({ ...BASE_CONTEXT_FIELDS, basis: mount, seedRun: null });
  expect(sent.basis).toEqual(mount);
});

it("sends both as null for a creation draft", async () => {
  const sent = await captureTurnRequest({
    ...BASE_CONTEXT_FIELDS,
    basis: null,
    seedRun: null,
  });

  expect(sent).toMatchObject({ basis: null, seedRun: null });
});

it("defaults basis and seedRun to null when the run context omits them", async () => {
  const sent = await captureTurnRequest({ ...BASE_CONTEXT_FIELDS });

  expect(sent).toMatchObject({ basis: null, seedRun: null });
});
