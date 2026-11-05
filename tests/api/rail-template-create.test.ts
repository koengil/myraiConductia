import { beforeEach, describe, expect, it, vi } from "vitest";

import { manifestFixture, queryStub } from "../support/railTemplateFixtures";

const BANK = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_BANK = "aaaaaaaa-0000-4000-8000-000000000002";
const TENANT = "bbbbbbbb-0000-4000-8000-000000000001";
const ACTOR = "cccccccc-0000-4000-8000-000000000001";
const OTHER_ACTOR = "cccccccc-0000-4000-8000-000000000002";
const DEAL = "dddddddd-0000-4000-8000-000000000001";
const TEMPLATE = "eeeeeeee-0000-4000-8000-000000000001";
const REVISION = "ffffffff-0000-4000-8000-000000000001";
const REQUEST = "99999999-0000-4000-8000-000000000001";
const STEP_ROW = "11111111-0000-4000-8000-000000000001";
const TARGET_COMPANY = "22222222-0000-4000-8000-000000000001";

const manifest = manifestFixture();

type Row = Record<string, unknown>;

const state = {
  authenticated: true,
  internal: "internal" as "internal" | "external" | "error",
  flagsOn: true,
  grants: [] as Array<{ companyId: string; key: string }>,
  tables: {} as Record<string, Row[]>,
  rpc: [] as Array<{ name: string; params: Record<string, unknown> }>,
  listed: [] as Row[],
  provisioned: [] as string[],
};

vi.mock("@/lib/flags/requireFlag", () => ({
  requireFlag: async () =>
    state.flagsOn ? null : Response.json({ error: "off" }, { status: 404 }),
}));

vi.mock("@/lib/api/v1/requireFlag", () => ({ isFlagEnabled: async () => true }));

vi.mock("@/lib/api/v1/access", () => ({
  classifyInternalUser: async () => state.internal,
  userCanAccessDeal: async () => true,
  listDealsForUser: async () => ({ data: state.listed, error: null }),
}));

vi.mock("@/lib/api/v1/companyAccess", () => ({
  hasCompanyPermissionChecked: async (
    _admin: unknown,
    _userId: string,
    companyId: string,
    key: string,
  ) => state.grants.some((g) => g.companyId === companyId && g.key === key),
}));

vi.mock("@/lib/dataroom/steps", () => ({
  loadDealByIdOrCode: async () => ({ id: DEAL, code: "ATLAS-2026-001" }),
  provisionDealDataroomOnCreate: async (_admin: unknown, dealId: string) => {
    state.provisioned.push(dealId);
  },
}));

vi.mock("@/lib/railTemplates/providerClient", () => ({
  importTemplateSkills: async (requestId: string, request: { projectId: string }) => ({
    requestId,
    projectId: request.projectId,
    skills: [],
  }),
}));

vi.mock("@/lib/api/v1/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/v1/http")>()),
  requireApiUser: async () =>
    state.authenticated
      ? {
          ok: true,
          user: { id: ACTOR },
          admin: {
            from: (table: string) => queryStub(state.tables[table] ?? []),
            rpc: async (name: string, params: Record<string, unknown>) => {
              state.rpc.push({ name, params });
              return { data: rpcResult(name), error: null };
            },
          },
        }
      : {
          ok: false,
          response: Response.json({ error: "Unauthorized" }, { status: 401 }),
        },
}));

function rpcResult(name: string) {
  if (name === "rail_template_admit_creation") {
    return {
      requestId: REQUEST,
      actorId: ACTOR,
      companyId: BANK,
      dealId: DEAL,
      revisionId: REVISION,
      manifest,
      input: {},
      stepIds: { t0: STEP_ROW },
      targets: [],
      state: "preparing",
      receipt: null,
    };
  }
  return {
    deal: { id: DEAL, code: "LANTE-2026-001" },
    memberships: [],
    notified: [{ userId: ACTOR, at: "2026-09-22T09:00:00.000Z" }],
    screening: { verdict: "approved", reasons: [] },
  };
}

function creationRow(overrides: Row = {}): Row {
  return {
    request_id: REQUEST,
    actor_id: ACTOR,
    company_id: BANK,
    revision_id: REVISION,
    reserved_deal_id: DEAL,
    input: {
      bankId: BANK,
      actorId: ACTOR,
      members: [],
      codename: "Project Lantern",
      tenantId: TENANT,
      conflicts: { approvedBy: "Avery Lindqvist", approvedOn: "2026-09-02" },
      screening: { reasons: [], verdict: "compliant" },
      targetName: "Canva",
      codenameTheme: null,
      targetCompanyId: null,
    },
    step_ids: { t0: STEP_ROW },
    targets: [],
    state: "preparing",
    receipt: null,
    ...overrides,
  };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    codename: "Project Lantern",
    targetName: "Canva",
    conflictsAttestation: {
      approvedBy: "Avery Lindqvist",
      approvedOn: "2026-09-02",
    },
    ...overrides,
  };
}

async function create(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/v1/deals/route");
  return POST(
    new Request("http://localhost/api/v1/deals", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

async function readCreation(requestId = REQUEST) {
  const { GET } = await import(
    "@/app/api/v1/deals/template-creations/[requestId]/route"
  );
  return GET(
    new Request(`http://localhost/api/v1/deals/template-creations/${requestId}`),
    { params: Promise.resolve({ requestId }) },
  );
}

async function resumeCreation(requestId = REQUEST) {
  const { POST } = await import(
    "@/app/api/v1/deals/template-creations/[requestId]/route"
  );
  return POST(
    new Request(`http://localhost/api/v1/deals/template-creations/${requestId}`, {
      method: "POST",
    }),
    { params: Promise.resolve({ requestId }) },
  );
}

describe("deal creation from a saved rail", () => {
  beforeEach(() => {
    state.authenticated = true;
    state.internal = "internal";
    state.flagsOn = true;
    state.grants = [{ companyId: BANK, key: "company:deals:create" }];
    state.rpc = [];
    state.listed = [];
    state.provisioned = [];
    state.tables = {
      users: [{ id: ACTOR, company_id: BANK, tenant_id: TENANT }],
      companies: [
        { id: BANK, tenant_id: TENANT, type: "bank", name: "Goldstone" },
        { id: TARGET_COMPANY, tenant_id: TENANT, type: "target", name: "Canva" },
      ],
      deal_memberships: [],
      deal_steps: [],
      rail_template_creations: [creationRow()],
      rail_template_revisions: [
        { id: REVISION, template_id: TEMPLATE, manifest },
      ],
    };
    vi.resetModules();
  });

  it("seeds the standard RPC with each member's role, defaulting to the deal team", async () => {
    await create(
      createBody({
        members: [
          { userId: OTHER_ACTOR, dealRole: "legal", note: "ignored" },
          { userId: STEP_ROW },
        ],
      }),
    );

    expect(state.rpc[0].params.p_members).toEqual([
      { userId: OTHER_ACTOR, dealRole: "legal" },
      { userId: STEP_ROW, dealRole: "deal_team" },
    ]);
  });

  it("refuses a standard create that names an unknown deal role", async () => {
    const response = await create(
      createBody({ members: [{ userId: OTHER_ACTOR, dealRole: "overlord" }] }),
    );

    expect(response.status).toBe(400);
    expect(state.rpc).toEqual([]);
  });

  it("routes a template selection through admission and finalization", async () => {
    const response = await create(
      createBody({
        requestId: REQUEST,
        railTemplate: { templateId: TEMPLATE, revisionId: REVISION },
      }),
    );

    expect(response.status).toBe(201);
    expect(state.rpc.map((call) => call.name)).toEqual([
      "rail_template_admit_creation",
      "rail_template_finalize_creation",
    ]);
    expect(await response.json()).toMatchObject({
      deal: { id: DEAL },
      screening: { verdict: "approved" },
    });
    expect(state.provisioned).toEqual([DEAL]);
    const leftOut = state.tables.deal_steps;
    expect(leftOut.length).toBeGreaterThan(0);
    expect(
      leftOut.every(
        (row) =>
          row.deal_id === DEAL &&
          row.origin === "catalog" &&
          typeof row.removed_at === "string",
      ),
    ).toBe(true);
  });

  it("never lets a caller supply the seed rows", async () => {
    await create(
      createBody({
        requestId: REQUEST,
        railTemplate: { templateId: TEMPLATE, revisionId: REVISION },
        seed: [{ id: STEP_ROW, stepId: "spoofed" }],
      }),
    );

    const finalize = state.rpc.find(
      (call) => call.name === "rail_template_finalize_creation",
    );
    expect(JSON.stringify(finalize?.params.p_seed)).not.toContain("spoofed");
  });

  it("refuses a template creation without a UUID request id", async () => {
    const response = await create(
      createBody({ railTemplate: { templateId: TEMPLATE, revisionId: REVISION } }),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("invalid_command");
    expect(state.rpc).toEqual([]);
  });

  it("refuses a template creation while the rail template flags are off", async () => {
    state.flagsOn = false;
    const response = await create(
      createBody({
        requestId: REQUEST,
        railTemplate: { templateId: TEMPLATE, revisionId: REVISION },
      }),
    );

    expect(response.status).toBe(404);
    expect(state.rpc).toEqual([]);
  });

  it("still screens the code name before a template is applied", async () => {
    const response = await create(
      createBody({
        codename: "Project Canva",
        requestId: REQUEST,
        railTemplate: { templateId: TEMPLATE, revisionId: REVISION },
      }),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).field).toBe("codename");
    expect(state.rpc).toEqual([]);
  });

  it("returns the frozen mandate and selection for the admitting actor", async () => {
    const response = await readCreation();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["input", "selection", "state"]);
    expect(body.selection).toEqual({
      templateId: TEMPLATE,
      revisionId: REVISION,
    });
    expect(body.input.codename).toBe("Project Lantern");
  });

  it("does not hand a creation to whoever holds the request id", async () => {
    state.tables.rail_template_creations = [
      creationRow({ actor_id: OTHER_ACTOR }),
    ];
    expect((await readCreation()).status).toBe(404);
  });

  it("does not hand a creation to an actor outside its company", async () => {
    state.tables.users = [{ id: ACTOR, company_id: OTHER_BANK, tenant_id: TENANT }];
    state.grants = [{ companyId: OTHER_BANK, key: "company:deals:create" }];
    expect((await readCreation()).status).toBe(404);
  });

  it("seeds the left-out standard steps when resuming a creation that already committed", async () => {
    state.tables.rail_template_creations = [
      creationRow({
        state: "ready",
        receipt: {
          deal: { id: DEAL, code: "LANTE-2026-001" },
          memberships: [],
          notified: [],
          screening: { verdict: "compliant", reasons: [] },
        },
      }),
    ];

    const response = await resumeCreation();

    expect(response.status).toBe(200);
    expect(state.rpc).toEqual([]);
    expect(state.tables.deal_steps.length).toBeGreaterThan(0);
    expect(
      state.tables.deal_steps.every(
        (row) => row.deal_id === DEAL && typeof row.removed_at === "string",
      ),
    ).toBe(true);
  });

  it("resumes an admitted creation with no body and reprovisions its data room", async () => {
    const response = await resumeCreation();

    expect(response.status).toBe(200);
    expect(state.rpc.map((call) => call.name)).toEqual([
      "rail_template_finalize_creation",
    ]);
    expect(state.provisioned).toEqual([DEAL]);
  });
});
