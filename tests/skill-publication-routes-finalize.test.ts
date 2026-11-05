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
  context,
  dealId,
  decisionBody,
  draftId,
  jsonRequest,
  placementBody,
  publicationId,
  publicationView,
  publishBody,
  resetRouteMocks,
} from "./support/skillPublicationRouteFixtures";
import { POST as publish } from "@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/publish/route";
import { POST as decideDuplicate } from "@/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/duplicate-decision/route";
import { POST as replacePlacement } from "@/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/placement/route";

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

it("advances once and registers an after drive on a successful publish", async () => {
  const response = await publish(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
      publishBody(),
    ),
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(202);
  expect(advancePublication).toHaveBeenCalledTimes(1);
  expect(advancePublication).toHaveBeenCalledWith(publicationId);
  expect(after).toHaveBeenCalledTimes(1);
  await after.mock.calls[0][0]();
  expect(drivePublication).toHaveBeenCalledWith(publicationId, 4);
});

it("still returns the admitted view with 202 when advancement throws", async () => {
  advancePublication.mockRejectedValue(new Error("boom"));
  const response = await publish(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
      publishBody(),
    ),
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(202);
  expect(after).toHaveBeenCalledTimes(1);
});

it("logs exactly the publication id, correlation id, and reason code when the after drive throws", async () => {
  drivePublication.mockRejectedValue(new Error("boom"));
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await publish(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
      publishBody(),
    ),
    context({ dealId, draftId }) as never,
  );
  await after.mock.calls[0][0]();
  expect(spy).toHaveBeenCalledTimes(1);
  const [logName, logPayload] = spy.mock.calls[0] as [string, unknown];
  expect(logName).toBe("[skill_publication_route]");
  expect(logPayload).toEqual({
    publicationId,
    correlationId: expect.any(String),
    reasonCode: "processor_error",
  });
  expect(Object.keys(logPayload as object).sort()).toEqual(
    ["publicationId", "correlationId", "reasonCode"].sort(),
  );
  spy.mockRestore();
});

it("advances once on a confirmed duplicate decision", async () => {
  const response = await decideDuplicate(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-publications/${publicationId}/duplicate-decision`,
      decisionBody("confirm"),
    ),
    context({ dealId, publicationId }) as never,
  );
  expect(response.status).toBe(202);
  expect(advancePublication).toHaveBeenCalledWith(publicationId);
});

it("declines a duplicate decision without advancing and returns the terminal view", async () => {
  rpc.mockResolvedValue({
    data: publicationView({ state: "failed" }),
    error: null,
  });
  const response = await decideDuplicate(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-publications/${publicationId}/duplicate-decision`,
      decisionBody("decline"),
    ),
    context({ dealId, publicationId }) as never,
  );
  expect(response.status).toBe(200);
  expect(advancePublication).not.toHaveBeenCalled();
  expect(after).not.toHaveBeenCalled();
});

it("advances once after a placement replacement", async () => {
  const response = await replacePlacement(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-publications/${publicationId}/placement`,
      placementBody(),
    ),
    context({ dealId, publicationId }) as never,
  );
  expect(response.status).toBe(202);
  expect(advancePublication).toHaveBeenCalledWith(publicationId);
});

it("returns the command's own view when the post-command read fails after a successful publish", async () => {
  rpc
    .mockResolvedValueOnce({
      data: publicationView({ state: "preparing" }),
      error: null,
    })
    .mockResolvedValueOnce({
      data: null,
      error: { code: "500", message: "read failed" },
    });
  const response = await publish(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
      publishBody(),
    ),
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body).toEqual(publicationView({ state: "preparing" }));
});

it("returns the command's own terminal view when the post-command read fails after a confirmed decision", async () => {
  rpc
    .mockResolvedValueOnce({
      data: publicationView({ state: "failed" }),
      error: null,
    })
    .mockResolvedValueOnce({
      data: null,
      error: { code: "500", message: "read failed" },
    });
  const response = await decideDuplicate(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-publications/${publicationId}/duplicate-decision`,
      decisionBody("confirm"),
    ),
    context({ dealId, publicationId }) as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual(publicationView({ state: "failed" }));
});

it("calls the admission RPC with the resolved deal id, not the raw route param", async () => {
  requireSkillAuthoringAccess.mockResolvedValue({
    ok: true,
    deal: { id: "resolved-deal-id", bankId: "bank-1" },
    userId: actorId,
  });
  await publish(
    jsonRequest(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
      publishBody(),
    ),
    context({ dealId, draftId }) as never,
  );
  expect(rpc).toHaveBeenCalledWith(
    "skill_publication_admit",
    expect.objectContaining({ p_deal_id: "resolved-deal-id" }),
  );
});
