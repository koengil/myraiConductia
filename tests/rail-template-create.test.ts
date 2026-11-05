import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ValidatedGate0Input } from "@/lib/deals/createDealInput";
import type {
  CreationAdmission,
  Gate0CreateReceipt,
  ImportRequest,
} from "@/lib/railTemplates/types";

import { manifestFixture, skillManifest } from "./support/railTemplateFixtures";

const BANK = "aaaaaaaa-0000-4000-8000-000000000001";
const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_BANK = "aaaaaaaa-0000-4000-8000-000000000002";
const ACTOR = "cccccccc-0000-4000-8000-000000000001";
const DEAL = "dddddddd-0000-4000-8000-000000000001";
const TEMPLATE = "eeeeeeee-0000-4000-8000-000000000001";
const REVISION = "ffffffff-0000-4000-8000-000000000001";
const REQUEST = "99999999-0000-4000-8000-000000000001";
const IMPORT_SKILL = "77777777-0000-4000-8000-000000000001";
const IMPORT_VERSION = "77777777-0000-4000-8000-000000000002";
const DIGEST = "d".repeat(64);

const selection = { templateId: TEMPLATE, revisionId: REVISION };

function input(overrides: Partial<ValidatedGate0Input> = {}): ValidatedGate0Input {
  return {
    tenantId: TENANT,
    actorId: ACTOR,
    bankId: BANK,
    codename: "Project Lantern",
    targetName: "Canva",
    targetCompanyId: null,
    codenameTheme: null,
    members: [],
    screening: { verdict: "approved", reasons: [] },
    conflicts: { approvedBy: "Avery Lindqvist", approvedOn: "2026-09-02" },
    ...overrides,
  };
}

function postgresJsonbKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) return value.map(postgresJsonbKeyOrder) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([left], [right]) =>
    left.length !== right.length
      ? left.length - right.length
      : left < right
        ? -1
        : left > right
          ? 1
          : 0,
  );
  return Object.fromEntries(
    entries.map(([key, item]) => [key, postgresJsonbKeyOrder(item)]),
  ) as T;
}

function receipt(): Gate0CreateReceipt {
  return {
    deal: { id: DEAL, code: "LANTE-2026-001" },
    memberships: [],
    notified: [{ userId: ACTOR, at: "2026-09-22T09:00:00.000Z" }],
    screening: { verdict: "approved", reasons: [] },
  };
}

function admission(overrides: Partial<CreationAdmission> = {}): CreationAdmission {
  return {
    requestId: REQUEST,
    actorId: ACTOR,
    companyId: BANK,
    dealId: DEAL,
    revisionId: REVISION,
    manifest: manifestFixture(),
    input: input(),
    stepIds: { t0: "11111111-0000-4000-8000-000000000001" },
    targets: [],
    state: "preparing",
    receipt: null,
    ...overrides,
  };
}

const skillTargets = [
  {
    key: "s0",
    operationId: "88888888-0000-4000-8000-000000000001",
    skillId: IMPORT_SKILL,
    versionId: IMPORT_VERSION,
  },
];

const state = {
  scopeCompanyId: BANK,
  scopeError: null as Error | null,
  skillFlag: true,
  admission: admission(),
  admitError: null as Error | null,
  admitCalls: [] as Array<{ requestId: string; selection: unknown }>,
  readResult: null as CreationAdmission | null,
  templateId: TEMPLATE as string | null,
  importCalls: [] as Array<{ requestId: string; request: ImportRequest }>,
  importError: null as Error | null,
  finalizeCalls: [] as Array<{ requestId: string; imports: unknown }>,
  finalizeError: null as Error | null,
  revalidateOk: true,
};

vi.mock("@/lib/api/v1/requireFlag", () => ({
  isFlagEnabled: async () => state.skillFlag,
}));

vi.mock("@/lib/railTemplates/access", () => ({
  requireTemplateUse: async () => {
    if (state.scopeError) throw state.scopeError;
    return { companyId: state.scopeCompanyId, tenantId: "t" };
  },
}));

vi.mock("@/lib/railTemplates/providerClient", () => ({
  importTemplateSkills: async (requestId: string, request: ImportRequest) => {
    state.importCalls.push({ requestId, request });
    if (state.importError) throw state.importError;
    return {
      requestId,
      projectId: request.projectId,
      skills: request.targets.map((target) => ({
        key: target.key,
        binding: {
          skillId: target.skillId,
          versionId: target.versionId,
          digest: DIGEST,
        },
      })),
    };
  },
}));

vi.mock("@/lib/railTemplates/creationRepository", () => ({
  admitCreation: async (
    _admin: unknown,
    _input: unknown,
    picked: unknown,
    requestId: string,
  ) => {
    state.admitCalls.push({ requestId, selection: picked });
    if (state.admitError) throw state.admitError;
    return state.admission;
  },
  readCreation: async () => state.readResult,
  readCreationTemplateId: async () => state.templateId,
  seedLeftOutSteps: async () => undefined,
  finalizeCreation: async (
    _admin: unknown,
    _actorId: string,
    requestId: string,
    imports: unknown,
  ) => {
    state.finalizeCalls.push({ requestId, imports });
    if (state.finalizeError) throw state.finalizeError;
    return receipt();
  },
}));

vi.mock("@/lib/deals/createDealInput", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deals/createDealInput")>()),
  validateGate0Input: async () =>
    state.revalidateOk
      ? { ok: true, input: input() }
      : { ok: false, rejection: { status: 422, body: { error: "changed" } } },
}));

const admin = {} as SupabaseClient;

async function load() {
  return import("@/lib/railTemplates/createDeal");
}

describe("creating a deal from a saved rail", () => {
  beforeEach(() => {
    state.scopeCompanyId = BANK;
    state.scopeError = null;
    state.skillFlag = true;
    state.admission = admission();
    state.admitError = null;
    state.admitCalls = [];
    state.readResult = null;
    state.templateId = TEMPLATE;
    state.importCalls = [];
    state.importError = null;
    state.finalizeCalls = [];
    state.finalizeError = null;
    state.revalidateOk = true;
    vi.resetModules();
  });

  it("imports the reserved skills into the reserved deal, then finalizes", async () => {
    state.admission = admission({
      manifest: skillManifest(),
      targets: skillTargets,
    });
    const { createDealFromTemplate } = await load();

    const created = await createDealFromTemplate(admin, input(), selection, REQUEST);

    expect(created.deal.id).toBe(DEAL);
    expect(state.importCalls).toEqual([
      {
        requestId: REQUEST,
        request: {
          companyId: TENANT,
          revisionId: REVISION,
          projectId: DEAL,
          targets: skillTargets,
        },
      },
    ]);
    expect(state.finalizeCalls).toHaveLength(1);
  });

  it("never calls the skill service for a rail that carries no skills", async () => {
    const { createDealFromTemplate } = await load();
    await createDealFromTemplate(admin, input(), selection, REQUEST);

    expect(state.importCalls).toEqual([]);
    expect(state.finalizeCalls[0]?.imports).toEqual({
      requestId: REQUEST,
      projectId: DEAL,
      skills: [],
    });
  });

  it("retries a lost provider response into a single creation", async () => {
    state.admission = admission({
      manifest: skillManifest(),
      targets: skillTargets,
    });
    const { createDealFromTemplate } = await load();

    const first = await createDealFromTemplate(admin, input(), selection, REQUEST);
    state.admission = { ...state.admission, state: "ready", receipt: first };
    const second = await createDealFromTemplate(admin, input(), selection, REQUEST);

    expect(second).toEqual(first);
    expect(state.finalizeCalls).toHaveLength(1);
    expect(state.importCalls).toHaveLength(1);
  });

  it("refuses a rail with skills when skill authoring is disabled", async () => {
    state.skillFlag = false;
    state.admission = admission({
      manifest: skillManifest(),
      targets: skillTargets,
    });
    const { createDealFromTemplate } = await load();

    await expect(
      createDealFromTemplate(admin, input(), selection, REQUEST),
    ).rejects.toMatchObject({ code: "skill_unavailable" });
    expect(state.importCalls).toEqual([]);
  });

  it("requires a UUID request id before anything is admitted", async () => {
    const { createDealFromTemplate } = await load();

    await expect(
      createDealFromTemplate(admin, input(), selection, "not-a-uuid"),
    ).rejects.toMatchObject({ code: "invalid_command" });
    expect(state.admitCalls).toEqual([]);
  });

  it("refuses a rail that belongs to another company", async () => {
    state.scopeCompanyId = OTHER_BANK;
    const { createDealFromTemplate } = await load();

    await expect(
      createDealFromTemplate(admin, input(), selection, REQUEST),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(state.admitCalls).toEqual([]);
  });

  it("surfaces a superseded revision as a stale template", async () => {
    state.admitError = new Error("stale_template");
    const { createDealFromTemplate } = await load();

    await expect(
      createDealFromTemplate(admin, input(), selection, REQUEST),
    ).rejects.toMatchObject({ code: "stale_template", status: 409 });
  });

  it("surfaces a code name already on a live deal as a conflict, not a fault", async () => {
    state.finalizeError = new Error("codename_taken");
    const { createDealFromTemplate } = await load();

    await expect(
      createDealFromTemplate(admin, input(), selection, REQUEST),
    ).rejects.toMatchObject({
      code: "codename_taken",
      status: 409,
      retryable: false,
    });
  });

  it("rejects a selection that is not a template revision pair", async () => {
    const { parseTemplateSelection } = await load();

    expect(() => parseTemplateSelection({ templateId: TEMPLATE })).toThrow();
    expect(parseTemplateSelection(selection)).toEqual(selection);
  });

  it("resumes an admitted request whose mandate came back in jsonb key order", async () => {
    const stored = postgresJsonbKeyOrder(input());
    expect(Object.keys(stored)).not.toEqual(Object.keys(input()));
    state.readResult = admission({ input: stored });
    const { resumeDealCreation } = await load();

    const resumed = await resumeDealCreation(admin, ACTOR, REQUEST);

    expect(resumed.deal.id).toBe(DEAL);
    expect(state.finalizeCalls).toHaveLength(1);
  });

  it("refuses to resume when the revalidated mandate differs in substance", async () => {
    state.readResult = admission({
      input: postgresJsonbKeyOrder(input({ codename: "Project Beacon" })),
    });
    const { resumeDealCreation } = await load();

    await expect(resumeDealCreation(admin, ACTOR, REQUEST)).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(state.finalizeCalls).toEqual([]);
  });

  it("creates nothing when the mandate no longer validates on resume", async () => {
    state.readResult = admission();
    state.revalidateOk = false;
    const { resumeDealCreation } = await load();

    await expect(resumeDealCreation(admin, ACTOR, REQUEST)).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(state.finalizeCalls).toEqual([]);
    expect(state.importCalls).toEqual([]);
  });

  it("reports an unknown request as not found", async () => {
    const { resumeDealCreation } = await load();

    await expect(resumeDealCreation(admin, ACTOR, REQUEST)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("projects a pending creation without its manifest or import targets", async () => {
    state.readResult = admission({
      manifest: skillManifest(),
      targets: skillTargets,
    });
    const { readDealCreation } = await load();

    const status = await readDealCreation(admin, ACTOR, REQUEST);

    expect(Object.keys(status ?? {}).sort()).toEqual([
      "input",
      "selection",
      "state",
    ]);
    expect(JSON.stringify(status)).not.toContain(IMPORT_SKILL);
    expect(status?.selection).toEqual(selection);
  });

  it("refuses to read a creation admitted for another company", async () => {
    state.readResult = admission({ companyId: OTHER_BANK });
    const { readDealCreation } = await load();

    await expect(readDealCreation(admin, ACTOR, REQUEST)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
