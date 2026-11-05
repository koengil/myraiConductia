import { beforeEach, describe, expect, it, vi } from "vitest";

const BINDING = {
  skillId: "2d362e20-0709-4ba0-bbd7-d21831148282",
  versionId: "0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6",
  digest: "a".repeat(64),
};

const STEP_ID = "custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6";
const DEAL_STEP_UUID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const RUN_ID = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
const DEAL_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_DEAL_ID = "99999999-9999-4999-8999-999999999999";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const RAIL_STEP_ID = "p2-s36";
const RAIL_DEAL_STEP_UUID = "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c";

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

const benchState = {
  skills: [] as Record<string, unknown>[],
  versionsByName: {} as Record<string, { current: number | null; versions: Record<string, unknown>[] }>,
  listSkillsError: null as Error | null,
};

vi.mock("@/lib/ignatious/config", () => ({
  readIgnatiousConfig: () => ({
    baseUrl: "https://plane.test",
    apiKey: "key",
    tenantId: "tenant-1",
    leadIdOverride: null,
    benchUrl: "https://bench.test",
    conductiaBaseUrl: "https://conductia.test",
  }),
}));

vi.mock("@/lib/ignatious/bench", async (original) => ({
  ...(await original<typeof import("@/lib/ignatious/bench")>()),
  createSkillBench: () => ({
    listSkills: async () => {
      if (benchState.listSkillsError) throw benchState.listSkillsError;
      return { skills: benchState.skills, defaultModel: null };
    },
    listVersions: async (name: string) =>
      benchState.versionsByName[name] ?? { current: null, versions: [] },
  }),
}));

import { POST } from "@/app/api/v1/deals/[dealId]/skill-drafts/route";

function benchSkill(overrides: Record<string, unknown> = {}) {
  return {
    name: "md-briefing",
    origin: "repo" as const,
    tag: { stageId: "phase-2", applicationId: "seq-36" },
    status: "ok" as const,
    reason: null,
    description: null,
    version: 3,
    model: null,
    modelFrom: "seed" as const,
    maxModel: null,
    maxEffort: null,
    routingFrom: "seed" as const,
    tester: null,
    testStatus: "untested" as const,
    enabled: true,
    sizeBytes: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

function stepRow(overrides: Record<string, unknown> = {}) {
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
        {
          key: "primary",
          kind: "text",
          label: "Input",
          helperText: "What to assess.",
          required: true,
        },
      ],
      skillBinding: BINDING,
    },
    assigned_to: null,
    status: "pending",
    ...overrides,
  };
}

function railStepRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RAIL_DEAL_STEP_UUID,
    step_id: RAIL_STEP_ID,
    origin: "rail",
    removed_at: null,
    work: { primary: "Draft the briefing" },
    definition: null,
    assigned_to: null,
    status: "pending",
    ...overrides,
  };
}

const state = {
  step: stepRow() as Record<string, unknown> | null,
  runs: [] as Record<string, unknown>[],
  draftRows: new Map<string, Record<string, unknown>>(),
};

function builderFor(table: string) {
  if (table === "deal_steps") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.step, error: null }) }),
        }),
      }),
    };
  }
  if (table === "deal_step_skill_bindings") {
    return {
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    };
  }
  if (table === "skill_authoring_drafts") {
    return {
      select: () => ({
        eq: (_column: string, value: unknown) => ({
          maybeSingle: async () => ({
            data: state.draftRows.get(value as string) ?? null,
            error: null,
          }),
        }),
      }),
    };
  }
  if (table === "deal_step_skill_runs") {
    return {
      select: () => {
        let rows = state.runs;
        const builder = {
          eq: (column: string, value: unknown) => {
            rows = rows.filter((row) => row[column] === value);
            return builder;
          },
          neq: (column: string, value: unknown) => {
            rows = rows.filter((row) => row[column] !== value);
            return builder;
          },
          maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        };
        return builder;
      },
    };
  }
  throw new Error(`Unexpected table ${table}`);
}

function context() {
  return { params: Promise.resolve({ dealId: DEAL_ID }) };
}

async function postDraft(
  body: Record<string, unknown>,
  options: { stepHasSkill?: boolean; stepMissing?: boolean } = {},
) {
  if (options.stepMissing) {
    state.step = null;
  } else if (options.stepHasSkill === false) {
    state.step = stepRow({ definition: {} });
  } else {
    state.step = stepRow();
  }
  const request = new Request(
    `https://conductia.test/api/v1/deals/${DEAL_ID}/skill-drafts`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const response = await POST(request, context() as never);
  return { response, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  state.step = stepRow();
  state.draftRows = new Map();
  state.runs = [
    {
      id: RUN_ID,
      deal_id: DEAL_ID,
      deal_step_id: DEAL_STEP_UUID,
      input: null,
      inputs: { asOf: "2026-09-30" },
      result_text: "High confidence.",
    },
  ];
  benchState.skills = [];
  benchState.versionsByName = {};
  benchState.listSkillsError = null;

  const drafts = new Map<string, string>();
  let seq = 0;
  rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "skill_authoring_get_or_create_draft") {
      throw new Error(`Unexpected rpc ${fn}`);
    }
    const key = `${args.p_actor_id}:${args.p_deal_id}:${args.p_basis_deal_step_id ?? "none"}`;
    let draftId = drafts.get(key);
    if (!draftId) {
      seq += 1;
      draftId = `33333333-3333-4333-8333-33333333333${seq}`;
      drafts.set(key, draftId);
      state.draftRows.set(draftId, {
        basis: args.p_basis ?? null,
        basis_deal_step_id: args.p_basis_deal_step_id ?? null,
        seed_run_id: args.p_seed_run_id ?? null,
      });
    }
    return {
      data: {
        draft: {
          id: draftId,
          deal_id: args.p_deal_id,
          status: "active",
          name: "",
          phase_index: null,
          placement_kind: null,
          anchor_deal_step_id: null,
          composer_text: "",
          edit_revision: 0,
          messages: [],
          active_attempt: null,
          candidate: null,
          publication: { available: false },
        },
      },
      error: null,
    };
  });
});

describe("opening an enhancement draft", () => {
  it("creates a creation draft when no basis is given", async () => {
    const { response, rpc } = await postDraft({});
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "skill_authoring_get_or_create_draft",
      expect.objectContaining({ p_basis_deal_step_id: null, p_basis: null, p_seed_run_id: null }),
    );
  });

  it("carries the step binding and the seed run onto an enhancement draft", async () => {
    const { response, rpc } = await postDraft({ basisStepId: STEP_ID, seedRunId: RUN_ID });

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "skill_authoring_get_or_create_draft",
      expect.objectContaining({
        p_basis_deal_step_id: DEAL_STEP_UUID,
        p_basis: { kind: "publication", ...BINDING },
        p_seed_run_id: RUN_ID,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      basisStepId: DEAL_STEP_UUID,
      seedRun: { input: "", inputs: { asOf: "2026-09-30" }, output: "High confidence." },
    });
  });

  it("resumes the same draft for the same step", async () => {
    const first = await postDraft({ basisStepId: STEP_ID });
    const second = await postDraft({ basisStepId: STEP_ID });
    await expect(second.response.json()).resolves.toMatchObject({
      draftId: (await first.response.json()).draftId,
    });
  });

  it("echoes the stored basis on resume, not the step's current binding", async () => {
    const REBOUND = {
      skillId: BINDING.skillId,
      versionId: "4f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6",
      digest: "e".repeat(64),
    };
    const SECOND_RUN_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    state.runs.push({
      id: SECOND_RUN_ID,
      deal_id: DEAL_ID,
      deal_step_id: DEAL_STEP_UUID,
      input: "Check Beta",
      result_text: "Low confidence.",
    });

    await postDraft({ basisStepId: STEP_ID, seedRunId: RUN_ID });

    const rebound = stepRow();
    (rebound.definition as Record<string, unknown>).skillBinding = REBOUND;
    state.step = rebound;

    const request = new Request(
      `https://conductia.test/api/v1/deals/${DEAL_ID}/skill-drafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ basisStepId: STEP_ID, seedRunId: SECOND_RUN_ID }),
      },
    );
    const response = await POST(request, context() as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      basis: { kind: "publication", ...BINDING },
      seedRunId: RUN_ID,
      seedRun: { input: "", inputs: { asOf: "2026-09-30" }, output: "High confidence." },
    });
  });

  it("falls back to the error message when the seed run failed and has no result", async () => {
    const FAILED_RUN_ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
    state.runs = [
      {
        id: FAILED_RUN_ID,
        deal_id: DEAL_ID,
        deal_step_id: DEAL_STEP_UUID,
        input: "Check Acme",
        result_text: null,
        error_message: "The skill returned an empty reply.",
      },
    ];

    const { response, rpc } = await postDraft({
      basisStepId: STEP_ID,
      seedRunId: FAILED_RUN_ID,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      seedRun: { input: "Check Acme", output: "The skill returned an empty reply." },
    });
    expect(rpc).toHaveBeenCalledWith(
      "skill_authoring_get_or_create_draft",
      expect.objectContaining({ p_seed_run_id: FAILED_RUN_ID }),
    );
  });

  it("refuses a step with no skill attached", async () => {
    const { response } = await postDraft({ basisStepId: STEP_ID }, { stepHasSkill: false });
    expect(response.status).toBe(409);
  });

  it("answers 404 for a basis step that does not exist", async () => {
    const { response, rpc } = await postDraft({ basisStepId: STEP_ID }, { stepMissing: true });
    expect(response.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not read a seed run belonging to another deal into the receipt", async () => {
    const foreignRunId = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
    state.runs = [
      {
        id: foreignRunId,
        deal_id: OTHER_DEAL_ID,
        deal_step_id: DEAL_STEP_UUID,
        input: "Secret plan",
        result_text: "Confidential.",
      },
    ];

    const { response, rpc } = await postDraft({ basisStepId: STEP_ID, seedRunId: foreignRunId });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.seedRun).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "skill_authoring_get_or_create_draft",
      expect.objectContaining({ p_seed_run_id: null }),
    );
  });

  it("does not take a revision of an output as the seed run", async () => {
    const revisionId = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
    state.runs = [
      {
        id: revisionId,
        deal_id: DEAL_ID,
        deal_step_id: DEAL_STEP_UUID,
        source: "revision",
        input: null,
        inputs: { kind: "edits", edits: [{ id: "e1", kind: "comment", comment: "Fix." }] },
        result_text: "Revised.",
      },
    ];

    const { response, rpc } = await postDraft({ basisStepId: STEP_ID, seedRunId: revisionId });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.seedRun).toBeUndefined();
    expect(rpc).toHaveBeenCalledWith(
      "skill_authoring_get_or_create_draft",
      expect.objectContaining({ p_seed_run_id: null }),
    );
  });

  it("resolves the live bench mount triple as the basis for a catalog step", async () => {
    state.step = railStepRow();
    benchState.skills = [benchSkill()];
    benchState.versionsByName = {
      "md-briefing": {
        current: 3,
        versions: [
          {
            version: 3,
            origin: "repo",
            updatedAt: "2026-09-01T00:00:00Z",
            updatedBy: null,
            downloadable: true,
            current: true,
            description: null,
            status: "ok",
            reason: null,
            sha256: "f".repeat(64),
            bytesRetained: true,
          },
        ],
      },
    };

    const request = new Request(
      `https://conductia.test/api/v1/deals/${DEAL_ID}/skill-drafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ basisStepId: RAIL_STEP_ID }),
      },
    );
    const response = await POST(request, context() as never);

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "skill_authoring_get_or_create_draft",
      expect.objectContaining({
        p_basis_deal_step_id: RAIL_DEAL_STEP_UUID,
        p_basis: { kind: "mount", name: "md-briefing", version: 3, digest: "f".repeat(64) },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ basisStepId: RAIL_DEAL_STEP_UUID });
  });

  it("surfaces a bench outage as the standard skill-service error response", async () => {
    state.step = railStepRow();
    const { IgnatiousRequestError } = await import("@/lib/ignatious/control-plane");
    benchState.listSkillsError = new IgnatiousRequestError(503, "Bench unreachable");

    const request = new Request(
      `https://conductia.test/api/v1/deals/${DEAL_ID}/skill-drafts`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ basisStepId: RAIL_STEP_ID }),
      },
    );
    const response = await POST(request, context() as never);

    expect(response.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });
});
