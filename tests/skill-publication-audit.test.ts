import { expect, it, vi } from "vitest";
import { writeSkillPublicationDenialAudit } from "@/lib/skillPublication/audit";

const actorId = "11111111-1111-4111-8111-111111111111";
const dealId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const correlationId = "55555555-5555-4555-8555-555555555555";

const ALLOWED_DETAIL_KEYS = [
  "draftId",
  "messageId",
  "attemptId",
  "candidateId",
  "actorId",
  "service",
  "fromState",
  "toState",
  "provider",
  "deployment",
  "fencingGeneration",
  "correlationId",
  "publicationId",
  "dealStepId",
  "digest",
  "reasonCode",
  "statusCode",
  "operationActorId",
];

function fakeAdmin() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ insert }));
  return { admin: { from }, from, insert };
}

it("inserts the exact row for an actor principal", async () => {
  const { admin, from, insert } = fakeAdmin();

  await writeSkillPublicationDenialAudit(admin, {
    actorId,
    dealId,
    draftId,
    correlationId,
    reasonCode: "access_denied",
  });

  expect(from).toHaveBeenCalledWith("audit_log");
  expect(insert).toHaveBeenCalledWith({
    actor_id: actorId,
    service_identity: null,
    action: "skill_publication.admission_denied",
    deal_id: dealId,
    detail: {
      reasonCode: "access_denied",
      correlationId,
      actorId,
      draftId,
    },
  });
});

it("inserts the exact row for the service principal conductia", async () => {
  const { admin, insert } = fakeAdmin();

  await writeSkillPublicationDenialAudit(admin, {
    dealId: null,
    correlationId,
    reasonCode: "service_unauthorized",
  });

  expect(insert).toHaveBeenCalledWith({
    actor_id: null,
    service_identity: "conductia",
    action: "skill_publication.admission_denied",
    deal_id: null,
    detail: {
      reasonCode: "service_unauthorized",
      correlationId,
      service: "conductia",
    },
  });
});

it("writes detail keys only from the audit-allowed list", async () => {
  const { admin, insert } = fakeAdmin();

  await writeSkillPublicationDenialAudit(admin, {
    actorId,
    dealId,
    draftId,
    correlationId,
    reasonCode: "access_lost",
  });

  const row = insert.mock.calls[0][0] as { detail: Record<string, unknown> };
  for (const key of Object.keys(row.detail)) {
    expect(ALLOWED_DETAIL_KEYS).toContain(key);
  }
});

it("throws when the correlation id is not a uuid", async () => {
  const { admin, insert } = fakeAdmin();

  await expect(
    writeSkillPublicationDenialAudit(admin, {
      actorId,
      correlationId: "not-a-uuid",
      reasonCode: "access_denied",
    }),
  ).rejects.toThrow();
  expect(insert).not.toHaveBeenCalled();
});

it("throws when the reason code is not a stable snake_case string", async () => {
  const { admin, insert } = fakeAdmin();

  await expect(
    writeSkillPublicationDenialAudit(admin, {
      actorId,
      correlationId,
      reasonCode: "Access-Denied",
    }),
  ).rejects.toThrow();
  expect(insert).not.toHaveBeenCalled();
});

it("throws when both an actor and a service principal are present", async () => {
  const { admin, insert } = fakeAdmin();

  await expect(
    writeSkillPublicationDenialAudit(admin, {
      actorId,
      service: "conductia",
      correlationId,
      reasonCode: "access_denied",
    }),
  ).rejects.toThrow();
  expect(insert).not.toHaveBeenCalled();
});

it("defaults to the service principal conductia when no actor is present", async () => {
  const { admin, insert } = fakeAdmin();

  await expect(
    writeSkillPublicationDenialAudit(admin, {
      actorId: null,
      correlationId,
      reasonCode: "access_denied",
      service: undefined,
    }),
  ).resolves.toBeUndefined();
  expect(insert).toHaveBeenCalledWith(
    expect.objectContaining({ service_identity: "conductia" }),
  );
});

it("throws when the insert itself fails", async () => {
  const { admin, insert } = fakeAdmin();
  insert.mockResolvedValue({ error: new Error("db down") });

  await expect(
    writeSkillPublicationDenialAudit(admin, {
      actorId,
      correlationId,
      reasonCode: "access_denied",
    }),
  ).rejects.toThrow("Unable to record skill publication access denial.");
});
