import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROTECTED_STEP_IDS } from "@/lib/rail/protectedSteps";
import type { DraftSourceStep } from "@/lib/railTemplates/railDraft";
import type { SaveRailCommand } from "@/lib/railTemplates/types";

const HOUSE_STEPS = [...PROTECTED_STEP_IDS];
const ACTOR = "cccccccc-0000-4000-8000-000000000001";
const BANK = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const DEAL = "dddddddd-0000-4000-8000-000000000001";
const REQUEST = "99999999-0000-4000-8000-000000000001";
const TEMPLATE = "eeeeeeee-0000-4000-8000-000000000001";
const REVISION = "ffffffff-0000-4000-8000-000000000001";
const DIGEST = "a".repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

const SUMMARY = {
  id: TEMPLATE,
  revisionId: REVISION,
  name: "Alpha rail",
  description: "Mid-market sale",
  stepCount: 3,
  skillCount: 1,
  version: 1,
  updatedAt: "2026-10-07T10:00:00.000Z",
};

const state = {
  skillAuthoring: true,
  steps: [] as DraftSourceStep[],
  rpc: {} as Record<string, RpcResult>,
  rpcCalls: [] as Array<{ name: string; params: Record<string, unknown> }>,
  retainCalls: [] as Array<{ revisionId: string; request: Record<string, unknown> }>,
  retainError: null as { code: string } | null,
  sourceError: null as Error | null,
};

vi.mock("@/lib/railTemplates/access", () => ({
  requireTemplateSave: async () => ({ dealId: DEAL, companyId: BANK, tenantId: TENANT }),
}));

vi.mock("@/lib/railTemplates/readSource", () => ({
  readRailSource: async () => {
    if (state.sourceError) throw state.sourceError;
    return { steps: state.steps, sourceFingerprint: "f".repeat(64) };
  },
}));

vi.mock("@/lib/api/v1/requireFlag", () => ({
  isFlagEnabled: async () => state.skillAuthoring,
}));

vi.mock("@/lib/railTemplates/providerClient", () => ({
  retainTemplateSkills: async (revisionId: string, request: Record<string, unknown>) => {
    state.retainCalls.push({ revisionId, request });
    if (state.retainError) throw Object.assign(new Error("retain failed"), state.retainError);
    return { revisionId, assets: [{ key: "s0", packageDigest: DIGEST }] };
  },
}));

const admin = {
  rpc: async (name: string, params: Record<string, unknown>) => {
    state.rpcCalls.push({ name, params });
    return state.rpc[name] ?? { data: null, error: null };
  },
} as unknown as SupabaseClient;

function house(stepId: string, order: number): DraftSourceStep {
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(order).padStart(12, "0")}`,
    stepId,
    origin: "catalog",
    seq: order,
    phaseIndex: 1,
    displayOrder: order,
    definition: null,
    templateStepKey: stepId,
    skill: null,
  };
}

function skillStep(): DraftSourceStep {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000900",
    stepId: "custom:aaaaaaaa-0000-4000-8000-000000000900",
    origin: "custom",
    seq: null,
    phaseIndex: 2,
    displayOrder: 900,
    definition: {
      schemaVersion: 1,
      type: "skill",
      title: "Buyer long list",
      description: "Ranks strategic buyers.",
      inputs: [
        { key: "primary", kind: "text", label: "Input", helperText: "Sector and size.", required: true },
      ],
      skillBinding: {
        skillId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        digest: DIGEST,
      },
    },
    templateStepKey: null,
    skill: {
      reference: {
        kind: "publication",
        skillId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        digest: DIGEST,
      },
      name: "Buyer long list",
      contract: { purpose: "p", expectedInput: "i", expectedOutput: "o" },
    },
  };
}

function command(overrides: Partial<SaveRailCommand> = {}): SaveRailCommand {
  return {
    requestId: REQUEST,
    sourceDealId: DEAL,
    description: "Mid-market sale",
    target: { kind: "new", name: "Alpha rail" },
    ...overrides,
  };
}

async function save(next: SaveRailCommand = command()) {
  const { saveRailToCatalog } = await import("@/lib/railTemplates/saveRail");
  return saveRailToCatalog(admin, ACTOR, next);
}

function calls() {
  return state.rpcCalls.map((call) => call.name);
}

function commitParams() {
  return state.rpcCalls.find((call) => call.name === "save_rail_to_catalog")?.params ?? {};
}

describe("saveRailToCatalog", () => {
  beforeEach(() => {
    state.skillAuthoring = true;
    state.steps = HOUSE_STEPS.map((stepId, index) => house(stepId, index + 1));
    state.rpc = {
      rail_catalog_save_check: { data: { tenantId: TENANT, target: null }, error: null },
      save_rail_to_catalog: { data: SUMMARY, error: null },
    };
    state.rpcCalls = [];
    state.retainCalls = [];
    state.retainError = null;
    state.sourceError = null;
    vi.resetModules();
  });

  it("saves a rail with no skills without calling the skill service", async () => {
    expect(await save()).toEqual(SUMMARY);

    expect(calls()).toEqual(["rail_catalog_save_replay", "rail_catalog_save_check", "save_rail_to_catalog"]);
    expect(state.retainCalls).toHaveLength(0);
    expect(commitParams()).toMatchObject({
      p_actor_id: ACTOR,
      p_company_id: BANK,
      p_deal_id: DEAL,
      p_request_id: REQUEST,
      p_target: { kind: "new", name: "Alpha rail" },
      p_description: "Mid-market sale",
      p_source_fingerprint: "f".repeat(64),
      p_revision_id: null,
      p_receipt: null,
    });
    expect((commitParams().p_steps as unknown[]).length).toBe(HOUSE_STEPS.length);
    expect(commitParams().p_protected_ids).toEqual(
      expect.arrayContaining(HOUSE_STEPS),
    );
  });

  it("retains the rail's skills under a new revision id, then commits with the receipt", async () => {
    state.steps = [...state.steps, skillStep()];

    await save();

    expect(state.retainCalls).toHaveLength(1);
    const { revisionId, request } = state.retainCalls[0];
    expect(revisionId).toMatch(UUID);
    expect(request).toEqual({
      companyId: TENANT,
      skills: [{ key: "s0", source: skillStep().skill?.reference }],
    });
    expect(commitParams()).toMatchObject({
      p_revision_id: revisionId,
      p_receipt: { revisionId, assets: [{ key: "s0", packageDigest: DIGEST }] },
    });
  });

  it.each([
    ["stale_template", 409],
    ["unpublished_changes", 409],
    ["name_taken", 409],
    ["source_changed", 409],
  ])("stops at the check on %s and copies nothing", async (code, status) => {
    state.steps = [...state.steps, skillStep()];
    state.rpc.rail_catalog_save_check = { data: null, error: { code: "P0002", message: code } };

    await expect(save()).rejects.toMatchObject({ code, status });
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).toEqual(["rail_catalog_save_replay", "rail_catalog_save_check"]);
  });

  it("refuses a rail with skills while skills are not enabled, before any copy", async () => {
    state.steps = [...state.steps, skillStep()];
    state.skillAuthoring = false;

    await expect(save()).rejects.toMatchObject({
      code: "skill_unavailable",
      message: "Skills are not enabled here, so this rail was not saved.",
    });
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).toEqual(["rail_catalog_save_replay", "rail_catalog_save_check"]);
  });

  it("refuses a rail it cannot map, before the retain", async () => {
    state.steps = [...state.steps, house(HOUSE_STEPS[0], 800)];

    await expect(save()).rejects.toMatchObject({
      code: "invalid_command",
      message: "This rail repeats a standard step.",
    });
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).not.toContain("save_rail_to_catalog");
  });

  it.each([
    [
      "a manual step description over 4,000 characters",
      { title: "Team memo", description: "x".repeat(4001) },
      "A step on this rail has a description over 4,000 characters.",
    ],
    [
      "a skill step description over 2,000 characters",
      { ...(skillStep().definition as Record<string, unknown>), description: "x".repeat(2001) },
      "A skill step on this rail needs a description of 1 to 2,000 characters.",
    ],
  ])("refuses a rail with %s, before the retain", async (_name, definition, message) => {
    state.steps = [
      ...state.steps,
      skillStep(),
      {
        ...skillStep(),
        id: "aaaaaaaa-0000-4000-8000-000000000901",
        displayOrder: 901,
        definition,
        templateStepKey: null,
        skill: null,
      },
    ];

    await expect(save()).rejects.toMatchObject({ code: "invalid_command", status: 422, message });
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).not.toContain("save_rail_to_catalog");
  });

  it.each(["order_differs", "nothing_to_publish"])("reports %s from the transaction", async (code) => {
    state.rpc.save_rail_to_catalog = { data: null, error: { code: "P0002", message: code } };

    await expect(save()).rejects.toMatchObject({ code, status: 409 });
  });

  it("keeps the template's skill block for a step the check reports as unchanged", async () => {
    const kept = {
      name: "Buyer long list",
      contract: { purpose: "p", expectedInput: "i", expectedOutput: "o" },
      source: { kind: "candidate", candidateId: "33333333-3333-4333-8333-333333333333", digest: DIGEST },
    };
    const step = { ...skillStep(), templateStepKey: "custom-kept" };
    state.steps = [...state.steps, step];
    state.rpc.rail_catalog_save_check = {
      data: {
        tenantId: TENANT,
        target: {
          catalogTemplateId: "77777777-0000-4000-8000-000000000001",
          description: "",
          steps: [{ stepId: "custom-kept", skill: kept, retainedDigest: DIGEST }],
        },
      },
      error: null,
    };

    await save(command({ target: { kind: "replace", templateId: TEMPLATE, expectedRevisionId: REVISION } }));

    expect(state.retainCalls[0].request).toEqual({
      companyId: TENANT,
      skills: [{ key: "s0", source: kept.source }],
    });
  });

  it("returns the first result for a request id that already completed, without checking, copying or committing", async () => {
    state.steps = [...state.steps, skillStep()];
    state.rpc.rail_catalog_save_replay = { data: SUMMARY, error: null };

    expect(await save()).toEqual(SUMMARY);

    expect(calls()).toEqual(["rail_catalog_save_replay"]);
    expect(state.rpcCalls[0].params).toEqual({
      p_actor_id: ACTOR,
      p_request_id: REQUEST,
      p_deal_id: DEAL,
    });
    expect(state.retainCalls).toHaveLength(0);
  });

  it("rejects a replace whose check answers no target, retaining and committing nothing", async () => {
    state.steps = [...state.steps, skillStep()];

    await expect(
      save(command({ target: { kind: "replace", templateId: TEMPLATE, expectedRevisionId: REVISION } })),
    ).rejects.toThrow("rail_template_response_invalid");
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).not.toContain("save_rail_to_catalog");
  });

  it("answers a source the reader refuses as a scoped failure, retaining and committing nothing", async () => {
    const { dbFailure } = await import("@/lib/errors/upstream");
    state.sourceError = dbFailure("Rail template source read", { code: "P0001", message: "not_found" });

    await expect(save()).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(state.retainCalls).toHaveLength(0);
    expect(calls()).not.toContain("rail_catalog_save_check");
    expect(calls()).not.toContain("save_rail_to_catalog");
  });

  it("stops before the commit when the skill service fails", async () => {
    state.steps = [...state.steps, skillStep()];
    state.retainError = { code: "provider_unavailable" };

    await expect(save()).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(calls()).not.toContain("save_rail_to_catalog");
  });

  it("answers an unknown raised state with its code and no status", async () => {
    state.rpc.save_rail_to_catalog = { data: null, error: { code: "P0003", message: "template_missing" } };

    const failure = await save().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: "P0003" });
    expect(failure).not.toHaveProperty("status");
  });

  it("never carries a database sentence into the error", async () => {
    state.rpc.save_rail_to_catalog = {
      data: null,
      error: { code: "P0001", message: "The database wrote this sentence." },
    };

    const failure = await save().catch((error: unknown) => error);

    expect((failure as Error).message).not.toContain("The database wrote this sentence.");
  });
});
