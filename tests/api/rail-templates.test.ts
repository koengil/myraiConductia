import { beforeEach, describe, expect, it, vi } from "vitest";

import { manifestFixture, queryStub } from "../support/railTemplateFixtures";

const BANK = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_BANK = "aaaaaaaa-0000-4000-8000-000000000002";
const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ACTOR = "cccccccc-0000-4000-8000-000000000001";
const DEAL = "dddddddd-0000-4000-8000-000000000001";
const TEMPLATE_ALPHA = "eeeeeeee-0000-4000-8000-000000000001";
const TEMPLATE_ZULU = "eeeeeeee-0000-4000-8000-000000000002";
const REVISION_ALPHA = "ffffffff-0000-4000-8000-000000000001";
const REVISION_ZULU = "ffffffff-0000-4000-8000-000000000002";
const CATALOG_TEMPLATE = "77777777-0000-4000-8000-000000000001";
const REQUEST = "99999999-0000-4000-8000-000000000001";
const NEW_REVISION = "99999999-0000-4000-8000-000000000002";

const manifest = manifestFixture();

type Row = Record<string, unknown>;

const state = {
  authenticated: true,
  internal: "internal" as "internal" | "external" | "error",
  dealExists: true,
  dealAccess: true,
  scopeReadFails: false,
  grants: [] as Array<{ companyId: string; key: string }>,
  unreadable: false,
  tables: {} as Record<string, Row[]>,
  rpc: [] as Array<{ name: string; params: Record<string, unknown> }>,
  disabledFlag: null as string | null,
  replay: null as Record<string, unknown> | null,
};

vi.mock("@/lib/flags/requireFlag", () => ({
  requireFlag: async (key: string) =>
    key === state.disabledFlag
      ? Response.json({ error: "Not found" }, { status: 404 })
      : null,
}));

vi.mock("@/lib/api/v1/requireFlag", () => ({ isFlagEnabled: async () => true }));

vi.mock("@/lib/api/v1/access", () => ({
  classifyInternalUser: async () => state.internal,
  userCanAccessDeal: async () => state.dealAccess,
}));

vi.mock("@/lib/api/v1/companyAccess", () => ({
  hasCompanyPermissionChecked: async (
    _admin: unknown,
    _userId: string,
    companyId: string,
    key: string,
  ) =>
    state.unreadable
      ? "unreadable"
      : state.grants.some(
          (grant) => grant.companyId === companyId && grant.key === key,
        ),
}));

vi.mock("@/lib/dataroom/steps", () => ({
  loadDealByIdOrCode: async () =>
    state.dealExists ? { id: DEAL, code: "ATLAS-2026-001" } : null,
}));

vi.mock("@/lib/railTemplates/readSource", async () => {
  const { PROTECTED_STEP_IDS } = await import("@/lib/rail/protectedSteps");
  return {
    readRailSource: async () => ({
      steps: [...PROTECTED_STEP_IDS].map((stepId, index) => ({
        id: `aaaaaaaa-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        stepId,
        origin: "catalog",
        seq: index + 1,
        phaseIndex: 1,
        displayOrder: index + 1,
        definition: null,
        templateStepKey: stepId,
        skill: null,
      })),
      sourceFingerprint: "a".repeat(64),
    }),
  };
});

vi.mock("@/lib/railTemplates/providerClient", () => ({
  retainTemplateSkills: async () => ({ revisionId: NEW_REVISION, assets: [] }),
}));

vi.mock("@/lib/api/v1/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/v1/http")>()),
  requireApiUser: async () =>
    state.authenticated
      ? {
          ok: true,
          user: { id: ACTOR },
          admin: {
            from: (table: string) => {
              const stub = queryStub(state.tables[table] ?? []);
              if (table !== "deals" || !state.scopeReadFails) return stub;
              // Only the scope read (bank_id, tenant_id) errors; the
              // access predicate's read selects tenant_id alone.
              return {
                ...stub,
                select: (columns: string) =>
                  columns.includes("bank_id")
                    ? {
                        eq: () => ({
                          maybeSingle: async () => ({
                            data: null,
                            error: { message: "scope read failed" },
                          }),
                        }),
                      }
                    : stub.select(),
              };
            },
            rpc: async (name: string, params: Record<string, unknown>) => {
              state.rpc.push({ name, params });
              return { data: rpcResult(name, params), error: null };
            },
          },
        }
      : {
          ok: false,
          response: Response.json({ error: "Unauthorized" }, { status: 401 }),
        },
}));

function rpcResult(name: string, params: Record<string, unknown>) {
  if (name === "rail_catalog_save_replay") {
    return state.replay;
  }
  if (name === "rail_catalog_save_check") {
    const target = params.p_target as { kind: string };
    return {
      tenantId: TENANT,
      target:
        target.kind === "replace"
          ? { catalogTemplateId: CATALOG_TEMPLATE, description: "", steps: [] }
          : null,
    };
  }
  if (name === "save_rail_to_catalog") {
    return {
      id: TEMPLATE_ALPHA,
      revisionId: NEW_REVISION,
      name: "Alpha rail",
      description: "Mid-market sale",
      stepCount: 3,
      skillCount: 0,
      version: 1,
      updatedAt: "2026-10-07T10:00:00.000Z",
    };
  }
  return {
    id: TEMPLATE_ALPHA,
    revisionId: NEW_REVISION,
    name: "Alpha rail",
    description: "",
    stepCount: manifest.steps.length,
    skillCount: manifest.skills.length,
    updatedAt: "2026-09-21T10:00:00.000Z",
  };
}

function templateRow(overrides: Row = {}): Row {
  return {
    id: TEMPLATE_ALPHA,
    company_id: BANK,
    name: "alpha rail",
    normalized_name: "alpha rail",
    current_revision_id: REVISION_ALPHA,
    ...overrides,
  };
}

function revisionRow(overrides: Row = {}): Row {
  return {
    id: REVISION_ALPHA,
    template_id: TEMPLATE_ALPHA,
    actor_id: ACTOR,
    command: { sourceDealId: DEAL },
    description: "Mid-market sale",
    manifest,
    state: "ready",
    created_at: "2026-09-20T09:00:00.000Z",
    ...overrides,
  };
}

function named(name: string) {
  return state.rpc.find((call) => call.name === name) ?? { name, params: {} };
}

function commit() {
  return named("save_rail_to_catalog");
}

async function list(search = "") {
  const { GET } = await import("@/app/api/v1/rail-templates/route");
  return GET(new Request(`http://localhost/api/v1/rail-templates${search}`));
}

async function preview(templateId: string) {
  const { GET } = await import("@/app/api/v1/rail-templates/[templateId]/route");
  return GET(new Request(`http://localhost/api/v1/rail-templates/${templateId}`), {
    params: Promise.resolve({ templateId }),
  });
}

async function save(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/v1/rail-templates/route");
  return POST(
    new Request("http://localhost/api/v1/rail-templates", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

function newCommand(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST,
    sourceDealId: "ATLAS-2026-001",
    description: "Mid-market sale",
    target: { kind: "new", name: "  Alpha   rail  " },
    ...overrides,
  };
}

describe("rail template routes", () => {
  beforeEach(() => {
    state.authenticated = true;
    state.internal = "internal";
    state.dealExists = true;
    state.dealAccess = true;
    state.scopeReadFails = false;
    state.unreadable = false;
    state.disabledFlag = null;
    state.replay = null;
    state.grants = [{ companyId: BANK, key: "company:deals:create" }];
    state.rpc = [];
    state.tables = {
      users: [{ id: ACTOR, company_id: BANK, tenant_id: TENANT }],
      deals: [{ id: DEAL, bank_id: BANK, tenant_id: TENANT }],
      rail_templates: [
        templateRow({
          id: TEMPLATE_ZULU,
          name: "Zulu rail",
          normalized_name: "zulu rail",
          current_revision_id: REVISION_ZULU,
        }),
        templateRow(),
      ],
      rail_catalog_templates: [
        { company_id: BANK, rail_template_id: TEMPLATE_ALPHA, deleted_at: null },
        { company_id: BANK, rail_template_id: TEMPLATE_ZULU, deleted_at: "2026-09-30T10:00:00.000Z" },
      ],
      rail_template_revisions: [
        revisionRow(),
        revisionRow({ id: REVISION_ZULU, template_id: TEMPLATE_ZULU }),
      ],
    };
    vi.resetModules();
  });

  it("requires an authenticated user before listing company rails", async () => {
    state.authenticated = false;
    expect((await list()).status).toBe(401);
  });

  it.each(["rail_templates", "project_rail_model", "gate0_api_create"])(
    "hides every rail template route while %s is off",
    async (flag) => {
      state.disabledFlag = flag;
      state.grants = [{ companyId: BANK, key: "company:deals:steps:structure" }];
      const responses = [
        await list(),
        await preview(TEMPLATE_ALPHA),
        await save(newCommand()),
      ];
      expect(responses.map((response) => response.status)).toEqual([
        404, 404, 404,
      ]);
      expect(state.rpc).toHaveLength(0);
    },
  );

  it("lists the company's rails for a creator with no source membership", async () => {
    state.dealAccess = false;
    const response = await list();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.templates.map((entry: { name: string }) => entry.name)).toEqual(
      ["alpha rail", "Zulu rail"],
    );
  });

  it("never returns source identifiers or manifests with a listed rail", async () => {
    const body = await (await list()).json();
    expect(Object.keys(body.templates[0]).sort()).toEqual([
      "description",
      "id",
      "name",
      "revisionId",
      "skillCount",
      "stepCount",
      "updatedAt",
    ]);
    expect(JSON.stringify(body)).not.toContain(DEAL);
  });

  it("omits a rail whose current revision was never made ready", async () => {
    state.tables.rail_templates = [templateRow({ current_revision_id: null })];
    const body = await (await list()).json();
    expect(body.templates).toEqual([]);
  });

  it("refuses an external user", async () => {
    state.internal = "external";
    const response = await list();
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("forbidden");
  });

  it("refuses a caller whose permission lookup cannot be read", async () => {
    state.unreadable = true;
    expect((await list()).status).toBe(403);
  });

  it("lets a template manager without deal-create authority open the save chooser", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    expect((await list("?purpose=save")).status).toBe(200);
    expect((await list()).status).toBe(403);
  });

  it("offers only catalog templates for replacement", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    const body = await (await list("?purpose=save")).json();
    expect(body.templates.map((template: { id: string }) => template.id)).toEqual([TEMPLATE_ALPHA]);
  });

  it("refuses the save chooser to a structure editor who cannot configure templates", async () => {
    state.grants = [{ companyId: BANK, key: "company:deals:steps:structure" }];
    expect((await list("?purpose=save")).status).toBe(403);
  });

  it("previews the current revision with step titles and no skill ids", async () => {
    const response = await preview(TEMPLATE_ALPHA);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe("alpha rail");
    expect(body.steps).toEqual([
      { title: "Weekly memo", phaseIndex: 2, displayOrder: 1 },
    ]);
    expect(JSON.stringify(body)).not.toContain("skillKey");
  });

  it("cannot preview a rail belonging to another company", async () => {
    state.tables.rail_templates = [templateRow({ company_id: OTHER_BANK })];
    expect((await preview(TEMPLATE_ALPHA)).status).toBe(404);
  });

  it("refuses a save from a creator who cannot configure templates", async () => {
    const response = await save(newCommand());
    expect(response.status).toBe(403);
    expect(state.rpc).toHaveLength(0);
  });

  it("answers an editor who cannot reach the source deal as if it did not exist", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    state.dealAccess = false;
    const hidden = await save(newCommand());
    expect(hidden.status).toBe(404);
    const hiddenBody = await hidden.json();
    expect(hiddenBody).toEqual({
      error: "That deal is not available.",
      code: "not_found",
      retryable: false,
      requestId: REQUEST,
    });
    expect(state.rpc).toHaveLength(0);

    state.dealExists = false;
    const missing = await save(newCommand());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(hiddenBody);
  });

  it("answers an unseated caller as if the deal did not exist even when the scope read fails", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    state.dealAccess = false;
    state.scopeReadFails = true;
    const hidden = await save(newCommand());
    expect(hidden.status).toBe(404);
    const hiddenBody = await hidden.json();

    state.dealExists = false;
    const missing = await save(newCommand());
    expect(missing.status).toBe(404);
    expect(hiddenBody).toEqual(await missing.json());
    expect(state.rpc).toHaveLength(0);

    // A seated caller still gets the refusal from the failed scope read.
    state.dealExists = true;
    state.dealAccess = true;
    expect((await save(newCommand())).status).toBe(403);
    expect(state.rpc).toHaveLength(0);
  });

  it("refuses a save from an external editor", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    state.internal = "external";
    const response = await save(newCommand());
    expect(response.status).toBe(403);
    expect(state.rpc).toHaveLength(0);
  });

  it("saves with the collapsed name, the canonical deal id and the company", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    const response = await save(newCommand());
    expect(response.status).toBe(200);
    expect(state.rpc.map((call) => call.name)).toEqual([
      "rail_catalog_save_replay",
      "rail_catalog_save_check",
      "save_rail_to_catalog",
    ]);
    expect(commit().params).toMatchObject({
      p_company_id: BANK,
      p_deal_id: DEAL,
      p_request_id: REQUEST,
      p_target: { kind: "new", name: "Alpha rail" },
    });
    expect((await response.json()).version).toBe(1);
  });

  it("lets a second editor replace a rail another editor created", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    const response = await save(
      newCommand({
        target: {
          kind: "replace",
          templateId: TEMPLATE_ALPHA,
          expectedRevisionId: REVISION_ALPHA,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(TEMPLATE_ALPHA);
    const target = {
      kind: "replace",
      templateId: TEMPLATE_ALPHA,
      expectedRevisionId: REVISION_ALPHA,
    };
    expect(named("rail_catalog_save_check").params.p_target).toEqual(target);
    expect(commit().params.p_target).toEqual(target);
  });

  it("returns the stored result of a completed request without checking or committing", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    state.replay = {
      id: TEMPLATE_ALPHA,
      revisionId: REVISION_ALPHA,
      name: "Alpha rail",
      description: "Mid-market sale",
      stepCount: 3,
      skillCount: 0,
      version: 4,
      updatedAt: "2026-10-07T10:00:00.000Z",
    };
    const response = await save(newCommand());
    expect(response.status).toBe(200);
    expect((await response.json()).version).toBe(4);
    expect(state.rpc.map((call) => call.name)).toEqual(["rail_catalog_save_replay"]);
    expect(named("rail_catalog_save_replay").params).toMatchObject({
      p_request_id: REQUEST,
      p_deal_id: DEAL,
    });
  });

  it("ignores a manifest or a company a save command carries", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    await save(newCommand({ companyId: OTHER_BANK, manifest: { steps: [] } }));
    const sent = commit().params;
    expect(sent.p_company_id).toBe(BANK);
    expect(sent.p_target).not.toHaveProperty("manifest");
    const { PROTECTED_STEP_IDS } = await import("@/lib/rail/protectedSteps");
    expect((sent.p_steps as Array<{ stepId: string }>).map((step) => step.stepId)).toEqual(
      [...PROTECTED_STEP_IDS],
    );
  });

  it("rejects an unusable save command before any database call", async () => {
    state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
    const response = await save(newCommand({ target: { kind: "new", name: "" } }));
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("invalid_command");
    expect(state.rpc).toHaveLength(0);
  });

  it.each(["default", " DEFAULT ", "Default"])(
    "refuses a rail named %j with its own sentence before any database call",
    async (name) => {
      state.grants = [{ companyId: BANK, key: "company:rails:templates:manage" }];
      const response = await save(newCommand({ target: { kind: "new", name } }));
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.code).toBe("invalid_command");
      expect(body.error).toBe("A saved rail cannot be named Default.");
      expect(state.rpc).toHaveLength(0);
    },
  );
});
