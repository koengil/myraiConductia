import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { DEAL_RAIL, orderedSteps } from "@/lib/rail/dealRail";
import { PROTECTED_STEP_IDS } from "@/lib/rail/protectedSteps";

import {
  DIGEST_ORIGINAL,
  DIGEST_SELECTED,
  SKILL_ID,
  VERSION_ORIGINAL,
  VERSION_SELECTED,
  binding,
  queryStub,
  skillDefinition,
} from "./support/railTemplateFixtures";

const ACTOR = "cccccccc-0000-4000-8000-000000000001";
const DEAL = "dddddddd-0000-4000-8000-000000000001";
const MOUNT_STEP = "p1-s10";
const MOUNT_DIGEST = "d".repeat(64);
const CENSUS = "hv-5x65-2026-07-08";

type Row = Record<string, unknown>;

const state = {
  configured: true,
  benchSkills: [] as Row[],
  benchVersions: [] as Row[],
  listSkillCalls: 0,
  steps: [] as Row[],
  bindings: [] as Row[],
  tables: {} as Record<string, Row[]>,
};

vi.mock("@/lib/ignatious/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ignatious/config")>()),
  readIgnatiousConfig: () =>
    state.configured
      ? { baseUrl: "http://bench", benchUrl: "http://bench", apiKey: "key" }
      : null,
}));

vi.mock("@/lib/ignatious/bench", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ignatious/bench")>()),
  createSkillBench: () => ({
    listSkills: async () => {
      state.listSkillCalls += 1;
      return { skills: state.benchSkills, defaultModel: null };
    },
    listVersions: async () => {
      return { current: 3, versions: state.benchVersions };
    },
  }),
}));

const admin = {
  from: (table: string) => queryStub(state.tables[table] ?? []),
  rpc: async () => ({
    data: {
      dealId: DEAL,
      censusVersion: CENSUS,
      steps: state.steps,
      bindings: state.bindings,
      sourceFingerprint: "a".repeat(64),
    },
    error: null,
  }),
} as unknown as SupabaseClient;

function catalogStep(stepId: string, displayOrder: number): Row {
  return {
    id: `11111111-0000-4000-8000-${String(displayOrder).padStart(12, "0")}`,
    stepId,
    origin: "catalog",
    seq: displayOrder,
    status: "pending",
    phaseIndex: 1,
    displayOrder,
    definition: null,
    removedAt: null,
  };
}

function protectedRail(): Row[] {
  return [...PROTECTED_STEP_IDS].map((stepId, index) =>
    catalogStep(stepId, index + 1),
  );
}

function customStep(overrides: Row = {}): Row {
  return {
    id: "22222222-0000-4000-8000-000000000001",
    stepId: "custom:source",
    origin: "custom",
    seq: null,
    status: "pending",
    phaseIndex: 2,
    displayOrder: 100,
    definition: skillDefinition(binding(VERSION_ORIGINAL, DIGEST_ORIGINAL)),
    removedAt: null,
    ...overrides,
  };
}

function operationRow(versionId: string, digest: string): Row {
  return {
    deal_id: DEAL,
    published_skill_id: SKILL_ID,
    published_version_id: versionId,
    published_digest: digest,
    name: "Weekly memo",
    capability_contract: {
      purpose: "Draft a weekly memo.",
      expectedInput: "A reporting period.",
      expectedOutput: "A concise memo.",
    },
    actor_id: ACTOR,
    created_at: "2026-09-01T08:00:00.000Z",
  };
}

function importRow(versionId: string, digest: string): Row {
  return {
    skill_id: SKILL_ID,
    deal_id: DEAL,
    version_id: versionId,
    digest,
    name: "Weekly memo (copied)",
    capability_contract: {
      purpose: "Draft a weekly memo for the new deal.",
      expectedInput: "A reporting period.",
      expectedOutput: "A concise memo.",
    },
    imported_by: ACTOR,
    created_at: "2026-09-05T08:00:00.000Z",
  };
}

function mountSkill(): Row {
  return {
    name: "meeting-intelligence",
    origin: "repo",
    tag: { stageId: "phase-1", applicationId: "seq-10" },
    status: "ok",
    reason: null,
    description: "Catalog copy",
    version: 3,
    model: null,
    modelFrom: "seed",
    maxModel: null,
    maxEffort: null,
    routingFrom: "seed",
    tester: null,
    testStatus: "untested",
    enabled: true,
    sizeBytes: null,
    updatedAt: null,
    updatedBy: null,
  };
}

async function capture() {
  const { readRailSource } = await import("@/lib/railTemplates/readSource");
  return readRailSource(admin, ACTOR, DEAL);
}

function skillOf(steps: Awaited<ReturnType<typeof capture>>["steps"], id: string) {
  return steps.find((step) => step.id === id)?.skill;
}

const CUSTOM_ID = "22222222-0000-4000-8000-000000000001";

describe("reading a source rail for a save", () => {
  beforeEach(() => {
    state.configured = false;
    state.benchSkills = [];
    state.benchVersions = [];
    state.listSkillCalls = 0;
    state.steps = protectedRail();
    state.bindings = [];
    state.tables = {};
    vi.resetModules();
  });

  it("carries the enhancement once the copied step is rebound to it", async () => {
    state.steps = [...protectedRail(), customStep()];
    state.bindings = [
      {
        dealStepId: CUSTOM_ID,
        kind: "publication",
        skillId: SKILL_ID,
        versionId: VERSION_SELECTED,
        mountName: null,
        mountVersion: null,
        digest: DIGEST_SELECTED,
      },
    ];
    state.tables.deal_skill_imports = [
      importRow(VERSION_ORIGINAL, DIGEST_ORIGINAL),
    ];
    state.tables.skill_publication_operations = [
      operationRow(VERSION_SELECTED, DIGEST_SELECTED),
    ];

    const { steps } = await capture();

    expect(skillOf(steps, CUSTOM_ID)).toEqual({
      reference: {
        kind: "publication",
        skillId: SKILL_ID,
        versionId: VERSION_SELECTED,
        digest: DIGEST_SELECTED,
      },
      name: "Weekly memo",
      contract: {
        purpose: "Draft a weekly memo.",
        expectedInput: "A reporting period.",
        expectedOutput: "A concise memo.",
      },
    });
  });

  it("carries the copied version a step still selects, not a later enhancement", async () => {
    state.steps = [...protectedRail(), customStep()];
    state.tables.deal_skill_imports = [
      importRow(VERSION_ORIGINAL, DIGEST_ORIGINAL),
    ];
    state.tables.skill_publication_operations = [
      operationRow(VERSION_SELECTED, DIGEST_SELECTED),
    ];

    const { steps } = await capture();

    expect(skillOf(steps, CUSTOM_ID)).toEqual({
      reference: {
        kind: "publication",
        skillId: SKILL_ID,
        versionId: VERSION_ORIGINAL,
        digest: DIGEST_ORIGINAL,
      },
      name: "Weekly memo (copied)",
      contract: {
        purpose: "Draft a weekly memo for the new deal.",
        expectedInput: "A reporting period.",
        expectedOutput: "A concise memo.",
      },
    });
  });

  it("refuses to save a step whose published skill has no readable metadata", async () => {
    state.steps = [...protectedRail(), customStep()];

    await expect(capture()).rejects.toMatchObject({
      code: "skill_unavailable",
    });
  });

  it("ignores a removed step and the skill it was bound to", async () => {
    state.steps = [
      ...protectedRail(),
      customStep({ removedAt: "2026-09-01T00:00:00.000Z" }),
    ];

    const { steps } = await capture();

    expect(steps).toHaveLength(PROTECTED_STEP_IDS.size);
    expect(steps.every((step) => step.skill === null)).toBe(true);
  });

  it("derives a house step's contract from its census description and io when a binding row names the skill", async () => {
    const mountStep = catalogStep(MOUNT_STEP, 500);
    state.steps = [...protectedRail(), mountStep];
    state.bindings = [
      {
        dealStepId: mountStep.id,
        kind: "mount",
        skillId: null,
        versionId: null,
        mountName: "meeting-intelligence",
        mountVersion: 3,
        digest: MOUNT_DIGEST,
      },
    ];

    const { steps } = await capture();
    const census = orderedSteps(DEAL_RAIL).find(
      (step) => step.id === MOUNT_STEP,
    );

    expect(skillOf(steps, String(mountStep.id))).toEqual({
      reference: {
        kind: "mount",
        name: "meeting-intelligence",
        version: 3,
        digest: MOUNT_DIGEST,
      },
      name: "meeting-intelligence",
      contract: {
        purpose: census?.description,
        expectedInput: census?.io.inputs.map((item) => item.what).join("\n"),
        expectedOutput: census?.io.outputs.map((item) => item.what).join("\n"),
      },
    });
  });

  it("leaves a house step with no binding row on the live firm skill and never calls the skill bench", async () => {
    state.configured = true;
    state.benchSkills = [mountSkill()];
    state.benchVersions = [];
    const mountStep = catalogStep(MOUNT_STEP, 500);
    state.steps = [...protectedRail(), mountStep];

    const { steps } = await capture();

    expect(skillOf(steps, String(mountStep.id))).toBeNull();
    expect(state.listSkillCalls).toBe(0);
  });

  it("refuses a source row whose step status is not a deal-step status", async () => {
    state.steps = [...protectedRail(), customStep({ status: "todo" })];

    await expect(capture()).rejects.toThrow("rail_template_response_invalid");
  });

  it("refuses a source row whose order is not a whole number", async () => {
    state.steps = [...protectedRail(), customStep({ displayOrder: 1.5 })];

    await expect(capture()).rejects.toThrow("rail_template_response_invalid");
  });
});
