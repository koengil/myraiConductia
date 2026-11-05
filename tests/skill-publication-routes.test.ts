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

import {
  actorId,
  badResourceRoutes,
  context,
  dealId,
  draftId,
  jsonRequest,
  publishBody,
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
  "hides %s behind the flag boundary before authentication",
  async (_name, handler, makeRequest, routeContext) => {
    requireFlag.mockResolvedValue(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(404);
    expect(requireApiUser).not.toHaveBeenCalled();
  },
);

it.each(routes)(
  "stops %s after authentication failure",
  async (_name, handler, makeRequest, routeContext) => {
    requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }),
    });
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(401);
    expect(requireSkillAuthoringAccess).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  },
);

it.each(badResourceRoutes)(
  "returns not found for %s with a malformed resource id, never reaching access checks",
  async (_name, handler, makeRequest, routeContext) => {
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(404);
    expect(requireSkillAuthoringAccess).not.toHaveBeenCalled();
  },
);

it.each(badResourceRoutes)(
  "returns 401, not 404, for %s when an unauthenticated request also has a malformed id",
  async (_name, handler, makeRequest, routeContext) => {
    requireApiUser.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
      }),
    });
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(401);
    expect(requireApiUser).toHaveBeenCalled();
  },
);

it.each(routes)(
  "denies %s on permission failure and audits the denial",
  async (_name, handler, makeRequest, routeContext) => {
    requireSkillAuthoringAccess.mockResolvedValue({
      ok: false,
      status: 403,
      message: "Not permitted.",
    });
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect(writeSkillPublicationDenialAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId,
        dealId,
        reasonCode: "access_denied",
      }),
    );
  },
);

// An unseated caller gets the missing deal's 404 (decision-log D65), but the
// refusal is still audited; a deal that truly does not resolve is not.
it.each(routes)(
  "answers %s for an unseated caller as a missing deal and still audits the denial",
  async (_name, handler, makeRequest, routeContext) => {
    requireSkillAuthoringAccess.mockResolvedValue({
      ok: false,
      status: 404,
      message: "Deal not found.",
      hidden: true,
    });
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Deal not found." });
    expect(rpc).not.toHaveBeenCalled();
    expect(writeSkillPublicationDenialAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorId, reasonCode: "access_denied" }),
    );
  },
);

it.each(routes)(
  "answers %s for a deal that does not resolve without a denial audit",
  async (_name, handler, makeRequest, routeContext) => {
    requireSkillAuthoringAccess.mockResolvedValue({
      ok: false,
      status: 404,
      message: "Deal not found.",
    });
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Deal not found." });
    expect(writeSkillPublicationDenialAudit).not.toHaveBeenCalled();
  },
);

it("audits a deal-code URL denial with a valid uuid or null, never the raw code", async () => {
  requireSkillAuthoringAccess.mockResolvedValue({
    ok: false,
    status: 403,
    message: "Not permitted.",
  });
  const dealCode = "SUM-2026-014";
  const response = await publish(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealCode}/skill-drafts/${draftId}/publish`,
      publishBody(),
    ),
    context({ dealId: dealCode, draftId }) as never,
  );
  expect(response.status).toBe(403);
  const call = writeSkillPublicationDenialAudit.mock.calls[0][1] as {
    dealId: string | null;
  };
  expect(call.dealId).not.toBe(dealCode);
  expect(call.dealId === null || /^[0-9a-f-]{36}$/i.test(call.dealId)).toBe(
    true,
  );
});

it("still returns 403 when the denial audit write itself fails", async () => {
  requireSkillAuthoringAccess.mockResolvedValue({
    ok: false,
    status: 403,
    message: "Not permitted.",
  });
  writeSkillPublicationDenialAudit.mockRejectedValue(new Error("db down"));
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const response = await publish(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
      publishBody(),
    ),
    context({ dealId, draftId }) as never,
  );

  expect(response.status).toBe(403);
  expect(spy).toHaveBeenCalledWith(
    "[skill_publication_audit]",
    expect.objectContaining({
      code: "SKILL_PUBLICATION_DENIAL_AUDIT_FAILED",
    }),
  );
  spy.mockRestore();
});

it.each(routes)(
  "returns 422 for %s on an invalid command without echoing the body",
  async (_name, handler, makeRequest, routeContext) => {
    const bad = jsonRequest(makeRequest().url, JSON.stringify({ nope: 1 }));
    const response = await handler(bad, routeContext as never);
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain("nope");
    expect(rpc).not.toHaveBeenCalled();
  },
);
