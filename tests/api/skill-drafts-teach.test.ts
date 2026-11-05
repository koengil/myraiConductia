import { beforeEach, describe, expect, it, vi } from "vitest";

const BINDING = {
  skillId: "2d362e20-0709-4ba0-bbd7-d21831148282",
  versionId: "0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6",
  digest: "a".repeat(64),
};

const STEP_ID = "custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6";
const DEAL_STEP_UUID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const RUN_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const FIRST_REVISION_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a51";
const SECOND_REVISION_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a52";
const FIRST_EDIT_ID = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1";
const SECOND_EDIT_ID = "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2";
const DEAL_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const { requireFlag, requireApiUser, requireSkillAuthoringAccess, rpc } = vi.hoisted(() => ({
  requireFlag: vi.fn(),
  requireApiUser: vi.fn(),
  requireSkillAuthoringAccess: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/api/v1/requireFlag", () => ({ requireFlag }));
vi.mock("@/lib/api/v1/http", async (original) => ({
  ...(await original<typeof import("@/lib/api/v1/http")>()),
  requireApiUser,
}));
vi.mock("@/lib/skillAuthoring/access", () => ({ requireSkillAuthoringAccess }));

import { POST } from "@/app/api/v1/deals/[dealId]/skill-drafts/route";

function stepRow() {
  return {
    id: DEAL_STEP_UUID,
    step_id: STEP_ID,
    origin: "custom",
    removed_at: null,
    work: { primary: "Check Acme" },
    definition: {
      schemaVersion: 1,
      type: "skill",
      title: "Check the target",
      description: "Assess the acquirer fit.",
      inputs: [
        { key: "primary", kind: "text", label: "Input", helperText: "What to assess.", required: true },
      ],
      skillBinding: BINDING,
    },
    assigned_to: null,
    status: "pending",
  };
}

function revisionRow(id: string, parentId: string, resultText: string, edit: Record<string, unknown>) {
  return {
    id,
    outcome: "succeeded",
    inputs: { kind: "edits", edits: [edit] },
    result_text: resultText,
    error_message: null,
    actor_id: ACTOR_ID,
    parent_run_id: parentId,
    root_run_id: RUN_ID,
    created_at: "2026-10-13T10:00:01.000Z",
  };
}

const state = {
  composer: "",
  draftRows: new Map<string, Record<string, unknown>>(),
  teachings: [] as Record<string, unknown>[],
  teachingReads: 0,
  offered: [] as Record<string, unknown>[],
};

function runsBuilder() {
  const root = {
    id: RUN_ID,
    deal_id: DEAL_ID,
    deal_step_id: DEAL_STEP_UUID,
    input: "Check Acme",
    inputs: {},
    result_text: "Hello there world.",
  };
  const revisions = [
    revisionRow(FIRST_REVISION_ID, RUN_ID, "Hi there world.", {
      id: FIRST_EDIT_ID,
      kind: "comment",
      start: 0,
      end: 5,
      comment: "Be direct",
      status: "applied",
      resultStart: 0,
      resultEnd: 2,
      teach: true,
    }),
    revisionRow(SECOND_REVISION_ID, FIRST_REVISION_ID, "Hi there planet.", {
      id: SECOND_EDIT_ID,
      kind: "comment",
      start: 9,
      end: 14,
      comment: "Name the planet",
      status: "applied",
      resultStart: 9,
      resultEnd: 15,
      teach: true,
    }),
  ];
  return {
    select: () => {
      const builder = {
        eq: () => builder,
        neq: () => builder,
        maybeSingle: async () => ({ data: root, error: null }),
        in: () => ({ order: async () => ({ data: revisions, error: null }) }),
      };
      return builder;
    },
  };
}

function builderFor(table: string) {
  if (table === "deal_steps") {
    return {
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stepRow(), error: null }) }) }),
      }),
    };
  }
  if (table === "deal_step_skill_bindings") {
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
  }
  if (table === "skill_authoring_drafts") {
    return {
      select: () => ({
        eq: (_column: string, value: unknown) => ({
          maybeSingle: async () => ({ data: state.draftRows.get(value as string) ?? null, error: null }),
        }),
      }),
    };
  }
  if (table === "deal_step_skill_runs") return runsBuilder();
  if (table === "skill_comment_teachings") {
    return {
      select: () => ({
        in: async () => {
          state.teachingReads += 1;
          return { data: state.teachings, error: null };
        },
      }),
    };
  }
  throw new Error(`Unexpected table ${table}`);
}

function draftReceipt(draftId: string, composerText: string) {
  return {
    draft: {
      id: draftId,
      deal_id: DEAL_ID,
      status: "active",
      name: "",
      phase_index: null,
      placement_kind: null,
      anchor_deal_step_id: null,
      composer_text: composerText,
      edit_revision: 0,
      messages: [],
      active_attempt: null,
      candidate: null,
      publication: { available: false },
    },
  };
}

async function postDraft(body: Record<string, unknown>) {
  const request = new Request(`https://conductia.test/api/v1/deals/${DEAL_ID}/skill-drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ dealId: DEAL_ID }) } as never);
}

const TEACH = { basisStepId: STEP_ID, seedRunId: RUN_ID, teach: true };

beforeEach(() => {
  vi.clearAllMocks();
  state.composer = "";
  state.draftRows = new Map();
  state.teachings = [];
  state.teachingReads = 0;
  state.offered = [];
  requireFlag.mockResolvedValue(null);
  requireApiUser.mockResolvedValue({
    ok: true,
    user: { id: ACTOR_ID, email: "author@example.com" },
    admin: { rpc, from: (table: string) => builderFor(table) },
  });
  requireSkillAuthoringAccess.mockResolvedValue({
    ok: true,
    deal: { id: DEAL_ID, bankId: "bank-1" },
    userId: ACTOR_ID,
  });

  const draftId = "33333333-3333-4333-8333-333333333331";
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "skill_authoring_get_or_create_draft") {
      if (!state.draftRows.has(draftId)) {
        state.draftRows.set(draftId, {
          basis: args.p_basis ?? null,
          basis_deal_step_id: args.p_basis_deal_step_id ?? null,
          seed_run_id: args.p_seed_run_id ?? null,
          composer_text: state.composer,
        });
      }
      const stored = state.draftRows.get(draftId) as { composer_text: string };
      return { data: draftReceipt(draftId, stored.composer_text), error: null };
    }
    if (fn === "skill_teaching_offer") {
      const edits = args.p_edits as { runId: string; editId: string }[];
      state.offered.push(args);
      const stored = state.draftRows.get(draftId) as { composer_text: string };
      stored.composer_text = args.p_prompt as string;
      for (const item of edits) {
        state.teachings.push({
          revision_run_id: item.runId,
          edit_id: item.editId,
          draft_id: draftId,
          kind: "waiting",
        });
      }
      return { data: { ...draftReceipt(draftId, args.p_prompt as string), offered: true }, error: null };
    }
    throw new Error(`Unexpected rpc ${fn}`);
  });
});

describe("opening the builder to teach the skill", () => {
  it("fills the draft with a prompt from the run's taught comments", async () => {
    const response = await postDraft(TEACH);

    expect(response.status).toBe(200);
    const [offer] = state.offered;
    expect(offer.p_edits).toEqual([
      { runId: FIRST_REVISION_ID, editId: FIRST_EDIT_ID },
      { runId: SECOND_REVISION_ID, editId: SECOND_EDIT_ID },
    ]);
    expect(offer.p_prompt).toContain('Comment: "Be direct"');
    expect(offer.p_prompt).toContain('Comment: "Name the planet"');
    expect(offer).toMatchObject({ p_actor_id: ACTOR_ID, p_deal_id: DEAL_ID });
    const body = await response.json();
    expect(body.draft.composerText).toBe(offer.p_prompt);
    expect(body.basisStepId).toBe(DEAL_STEP_UUID);
    expect(body.seedRunId).toBe(RUN_ID);
  });

  it("opens the same draft twice and adds the prompt once", async () => {
    await postDraft(TEACH);
    const second = await postDraft(TEACH);

    expect(second.status).toBe(200);
    expect(state.offered).toHaveLength(1);
    const body = await second.json();
    expect(body.draft.composerText).toContain('Comment: "Be direct"');
  });

  it("answers with a fresh receipt when every comment is already waiting on this draft", async () => {
    const draftId = "33333333-3333-4333-8333-333333333331";
    state.teachings = [
      { revision_run_id: FIRST_REVISION_ID, edit_id: FIRST_EDIT_ID, draft_id: draftId, kind: "waiting" },
      { revision_run_id: SECOND_REVISION_ID, edit_id: SECOND_EDIT_ID, draft_id: draftId, kind: "waiting" },
    ];
    const standard = rpc.getMockImplementation() as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    let opens = 0;
    rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "skill_authoring_get_or_create_draft") return standard(fn, args);
      opens += 1;
      state.draftRows.set(draftId, {
        basis: args.p_basis ?? null,
        basis_deal_step_id: args.p_basis_deal_step_id ?? null,
        seed_run_id: args.p_seed_run_id ?? null,
        composer_text: opens === 1 ? "" : "offered prompt",
      });
      const receipt = draftReceipt(draftId, opens === 1 ? "" : "offered prompt");
      receipt.draft.edit_revision = opens === 1 ? 0 : 4;
      return { data: receipt, error: null };
    });

    const response = await postDraft(TEACH);

    expect(response.status).toBe(200);
    expect(opens).toBe(2);
    expect(state.offered).toHaveLength(0);
    const body = await response.json();
    expect(body.draft.composerText).toBe("offered prompt");
    expect(body.draft.editRevision).toBe(4);
  });

  it("offers a comment that is waiting on a different draft", async () => {
    state.teachings = [
      {
        revision_run_id: FIRST_REVISION_ID,
        edit_id: FIRST_EDIT_ID,
        draft_id: "33333333-3333-4333-8333-333333333399",
        kind: "waiting",
      },
    ];

    const response = await postDraft(TEACH);

    expect(response.status).toBe(200);
    const [offer] = state.offered;
    expect(offer.p_edits).toEqual([
      { runId: FIRST_REVISION_ID, editId: FIRST_EDIT_ID },
      { runId: SECOND_REVISION_ID, editId: SECOND_EDIT_ID },
    ]);
  });

  it("opens the draft without a prompt when the offer meets a publication freeze", async () => {
    const standard = rpc.getMockImplementation() as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) =>
      fn === "skill_teaching_offer"
        ? {
            data: null,
            error: {
              code: "40001",
              message: "skill_authoring_conflict",
              details: JSON.stringify({
                draft: draftReceipt("33333333-3333-4333-8333-333333333331", "").draft,
                active_attempt: null,
              }),
            },
          }
        : standard(fn, args),
    );

    const response = await postDraft(TEACH);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.draft.composerText).toBe("");
  });

  it("opens the draft unchanged when no comment fits", async () => {
    state.composer = "x".repeat(19_990);

    const response = await postDraft(TEACH);

    expect(response.status).toBe(200);
    expect(state.offered).toHaveLength(0);
    const body = await response.json();
    expect(body.draft.composerText).toBe(state.composer);
  });

  it("answers 404 when skill output revisions are off", async () => {
    const { NextResponse } = await import("next/server");
    requireFlag.mockImplementation(async (flag: string) =>
      flag === "skill_output_revisions" ? NextResponse.json({ error: "Not found" }, { status: 404 }) : null,
    );

    const response = await postDraft(TEACH);

    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("answers 422 when teach comes without a step or a run", async () => {
    const withoutRun = await postDraft({ basisStepId: STEP_ID, teach: true });
    const withoutStep = await postDraft({ seedRunId: RUN_ID, teach: true });

    expect(withoutRun.status).toBe(422);
    expect(withoutStep.status).toBe(422);
    await expect(withoutRun.json()).resolves.toEqual({
      error: "Teaching the skill needs the step and the run it reviewed.",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not offer anything without teach", async () => {
    const response = await postDraft({ basisStepId: STEP_ID, seedRunId: RUN_ID });

    expect(response.status).toBe(200);
    expect(state.offered).toHaveLength(0);
    expect(state.teachingReads).toBe(0);
    expect(requireFlag).not.toHaveBeenCalledWith("skill_output_revisions");
    const body = await response.json();
    expect(body.draft.composerText).toBe("");
  });
});
