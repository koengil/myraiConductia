import { beforeEach, expect, it, vi } from "vitest";

const {
  requireFlag,
  requireApiUser,
  requireSkillAuthoringAccess,
  advancePublication,
  drivePublication,
  writeSkillPublicationDenialAudit,
  after,
  rpc,
} = vi.hoisted(() => ({
  requireFlag: vi.fn(),
  requireApiUser: vi.fn(),
  requireSkillAuthoringAccess: vi.fn(),
  advancePublication: vi.fn(),
  drivePublication: vi.fn(),
  writeSkillPublicationDenialAudit: vi.fn(),
  after: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/api/v1/requireFlag", () => ({ requireFlag }));
vi.mock("@/lib/api/v1/http", async (original) => ({
  ...(await original<typeof import("@/lib/api/v1/http")>()),
  requireApiUser,
}));
vi.mock("@/lib/skillAuthoring/access", () => ({
  requireSkillAuthoringAccess,
}));
vi.mock("@/lib/skillPublication/processor", () => ({
  advancePublication,
  drivePublication,
}));
vi.mock("@/lib/skillPublication/audit", () => ({
  writeSkillPublicationDenialAudit,
  SKILL_PUBLICATION_AUDIT_ACTION: {
    ADMISSION_DENIED: "skill_publication.admission_denied",
  },
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after,
}));

import { PUBLICATION_CONFLICT_CODES } from "@/lib/skillPublication/types";
import {
  actorId,
  candidateId,
  context,
  dealId,
  digest,
  draftId,
  jsonRequest,
  publicationView,
  publishBody,
  requestId,
  resetRouteMocks,
  routes,
} from "./support/skillPublicationRouteFixtures";
import { POST as publish } from "@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/publish/route";

beforeEach(() => {
  vi.clearAllMocks();
  resetRouteMocks({
    requireFlag,
    requireApiUser,
    requireSkillAuthoringAccess,
    advancePublication,
    drivePublication,
    writeSkillPublicationDenialAudit,
    rpc,
  });
});

it.each(routes)(
  "maps every publication conflict code from %s to a 409 with only the code",
  async (_name, handler, makeRequest, routeContext, rpcName) => {
    for (const code of PUBLICATION_CONFLICT_CODES) {
      rpc.mockImplementation((name: string) =>
        name === rpcName
          ? Promise.resolve({
              data: null,
              error: { code: "40001", message: code },
            })
          : Promise.resolve({ data: publicationView(), error: null }),
      );
      const response = await handler(makeRequest(), routeContext as never);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: code });
      expect(advancePublication).not.toHaveBeenCalled();
      expect(writeSkillPublicationDenialAudit).not.toHaveBeenCalled();
    }
  },
);

const errorScenarios = [
  [
    "invalid",
    "22023",
    "skill_publication_blank_name",
    422,
    "Invalid skill save request.",
    null,
  ],
  [
    "not found",
    "P0002",
    "skill_publication_not_found",
    404,
    "Not found.",
    null,
  ],
  [
    "access lost",
    "42501",
    "skill_authoring_forbidden",
    403,
    "Not permitted.",
    "access_lost",
  ],
  [
    "concurrent operation on the same step",
    "23505",
    "duplicate key value violates unique constraint \"skill_publication_one_live_per_step_idx\"",
    409,
    "publication_exists",
    null,
  ],
  [
    "unmapped code",
    "23514",
    "relation audit_log violates check constraint",
    500,
    "Unable to process the skill save request.",
    null,
  ],
  [
    "unmapped 40001 message",
    "40001",
    "relation x violates constraint",
    500,
    "Unable to process the skill save request.",
    null,
  ],
] as const;

for (const [routeName, handler, makeRequest, routeContext, rpcName] of routes) {
  for (const [
    scenarioName,
    code,
    message,
    status,
    expectedError,
    auditReasonCode,
  ] of errorScenarios) {
    it(`maps a ${scenarioName} RPC error from ${routeName} to ${status} with the exact body`, async () => {
      rpc.mockImplementation((name: string) =>
        name === rpcName
          ? Promise.resolve({ data: null, error: { code, message } })
          : Promise.resolve({ data: publicationView(), error: null }),
      );
      const response = await handler(makeRequest(), routeContext as never);
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toEqual({ error: expectedError });
      expect(JSON.stringify(body)).not.toContain(message);
      if (auditReasonCode) {
        expect(writeSkillPublicationDenialAudit).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ actorId, reasonCode: auditReasonCode }),
        );
      } else {
        expect(writeSkillPublicationDenialAudit).not.toHaveBeenCalled();
      }
    });
  }
}

const SAFE_VIEW_KEYS = [
  "available",
  "assessmentDigest",
  "error",
  "id",
  "matches",
  "result",
  "revision",
  "state",
].sort();

const publishedResult = {
  stepId: draftId,
  skillBinding: { skillId: candidateId, versionId: requestId, digest },
};

it.each([
  ["preparing", 202],
  ["attaching", 202],
  ["published", 200],
  ["failed", 200],
])(
  "returns %s and status %s from the resolved publication view",
  async (state, status) => {
    rpc.mockResolvedValue({
      data: publicationView({
        state,
        result: state === "published" ? publishedResult : null,
      }),
      error: null,
    });
    const response = await publish(
      jsonRequest(
        `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
        publishBody(),
      ),
      context({ dealId, draftId }) as never,
    );
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(SAFE_VIEW_KEYS);
  },
);
