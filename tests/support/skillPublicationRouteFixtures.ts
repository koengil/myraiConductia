import type { Mock } from "vitest";
import { POST as publish } from "@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/publish/route";
import { POST as decideDuplicate } from "@/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/duplicate-decision/route";
import { POST as replacePlacement } from "@/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/placement/route";

export const actorId = "11111111-1111-4111-8111-111111111111";
export const dealId = "22222222-2222-4222-8222-222222222222";
export const draftId = "33333333-3333-4333-8333-333333333333";
export const publicationId = "44444444-4444-4444-8444-444444444444";
export const requestId = "55555555-5555-4555-8555-555555555555";
export const candidateId = "66666666-6666-4666-8666-666666666666";
export const afterStepId = "77777777-7777-4777-8777-777777777777";
export const digest = "a".repeat(64);

export const context = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});

export function publicationView(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    id: publicationId,
    state: "preparing",
    revision: 1,
    matches: [],
    error: null,
    result: null,
    assessmentDigest: null,
    ...overrides,
  };
}

export function jsonRequest(url: string, body: string) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

export const publishBody = () =>
  JSON.stringify({
    requestId,
    expectedEditRevision: 3,
    candidateId,
    candidateDigest: digest,
  });

export const decisionBody = (decision: "confirm" | "decline" = "confirm") =>
  JSON.stringify({ expectedRevision: 2, assessmentDigest: digest, decision });

export const placementBody = () =>
  JSON.stringify({
    expectedRevision: 4,
    placement: { kind: "after", phaseIndex: 2, afterStepId },
  });

export const routes = [
  [
    "publish",
    publish,
    () =>
      jsonRequest(
        `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/publish`,
        publishBody(),
      ),
    context({ dealId, draftId }),
    "skill_publication_admit",
  ],
  [
    "duplicate-decision",
    decideDuplicate,
    () =>
      jsonRequest(
        `https://conductia.test/api/v1/deals/${dealId}/skill-publications/${publicationId}/duplicate-decision`,
        decisionBody(),
      ),
    context({ dealId, publicationId }),
    "skill_publication_decide_duplicate",
  ],
  [
    "placement",
    replacePlacement,
    () =>
      jsonRequest(
        `https://conductia.test/api/v1/deals/${dealId}/skill-publications/${publicationId}/placement`,
        placementBody(),
      ),
    context({ dealId, publicationId }),
    "skill_publication_replace_placement",
  ],
] as const;

export const badResourceRoutes = [
  [
    "publish",
    publish,
    () =>
      jsonRequest(
        `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/not-a-uuid/publish`,
        publishBody(),
      ),
    context({ dealId, draftId: "not-a-uuid" }),
  ],
  [
    "duplicate-decision",
    decideDuplicate,
    () =>
      jsonRequest(
        `https://conductia.test/api/v1/deals/${dealId}/skill-publications/not-a-uuid/duplicate-decision`,
        decisionBody(),
      ),
    context({ dealId, publicationId: "not-a-uuid" }),
  ],
  [
    "placement",
    replacePlacement,
    () =>
      jsonRequest(
        `https://conductia.test/api/v1/deals/${dealId}/skill-publications/not-a-uuid/placement`,
        placementBody(),
      ),
    context({ dealId, publicationId: "not-a-uuid" }),
  ],
] as const;

export type RouteMocks = {
  requireFlag: Mock;
  requireApiUser: Mock;
  requireSkillAuthoringAccess: Mock;
  advancePublication: Mock;
  drivePublication: Mock;
  writeSkillPublicationDenialAudit: Mock;
  rpc: Mock;
};

export function resetRouteMocks(mocks: RouteMocks): void {
  mocks.requireFlag.mockResolvedValue(null);
  mocks.requireApiUser.mockResolvedValue({
    ok: true,
    user: { id: actorId, email: "author@example.com" },
    admin: { rpc: mocks.rpc },
  });
  mocks.requireSkillAuthoringAccess.mockResolvedValue({
    ok: true,
    deal: { id: dealId, bankId: "bank-1" },
    userId: actorId,
  });
  mocks.advancePublication.mockResolvedValue({
    publicationId,
    state: "preparing",
    progressed: true,
  });
  mocks.drivePublication.mockResolvedValue({
    publicationId,
    state: "preparing",
    progressed: true,
  });
  mocks.writeSkillPublicationDenialAudit.mockResolvedValue(undefined);
  mocks.rpc.mockResolvedValue({ data: publicationView(), error: null });
}
