import { describe, expect, it } from "vitest";
import { createRecoveryAdmin } from "./recoveryAdmin";
import { baseRecoveryOperationRow } from "./recoveryOperationRow";

async function refusesReceiptChange(): Promise<void> {
  const admin = createRecoveryAdmin();
  const op = baseRecoveryOperationRow({
    state: "attaching",
    published_skill_id: "skill-a",
    published_version_id: "version-a",
    published_digest: "a".repeat(64),
  });
  admin.insertOperation(op);

  const result = await admin.admin.rpc("skill_publication_transition", {
    p_publication_id: op.id,
    p_expected_states: ["attaching"],
    p_next_state: "attaching",
    p_patch: { publishedVersionId: "version-b" },
  });

  expect(result.error).not.toBeNull();
  expect(admin.getOperation(op.id).published_version_id).toBe("version-a");
}

async function refusesSkillIdOnlyChange(): Promise<void> {
  const admin = createRecoveryAdmin();
  const op = baseRecoveryOperationRow({
    state: "attaching",
    published_skill_id: "skill-a",
    published_version_id: "version-a",
    published_digest: "a".repeat(64),
  });
  admin.insertOperation(op);

  const result = await admin.admin.rpc("skill_publication_transition", {
    p_publication_id: op.id,
    p_expected_states: ["attaching"],
    p_next_state: "attaching",
    p_patch: { publishedSkillId: "skill-b" },
  });

  expect(result.error).not.toBeNull();
  expect(admin.getOperation(op.id).published_skill_id).toBe("skill-a");
}

async function refusesDigestOnlyChange(): Promise<void> {
  const admin = createRecoveryAdmin();
  const op = baseRecoveryOperationRow({
    state: "attaching",
    published_skill_id: "skill-a",
    published_version_id: "version-a",
    published_digest: "a".repeat(64),
  });
  admin.insertOperation(op);

  const result = await admin.admin.rpc("skill_publication_transition", {
    p_publication_id: op.id,
    p_expected_states: ["attaching"],
    p_next_state: "attaching",
    p_patch: { publishedDigest: "b".repeat(64) },
  });

  expect(result.error).not.toBeNull();
  expect(admin.getOperation(op.id).published_digest).toBe("a".repeat(64));
}

async function allowsRepeatingSameReceipt(): Promise<void> {
  const admin = createRecoveryAdmin();
  const op = baseRecoveryOperationRow({
    state: "attaching",
    published_skill_id: "skill-a",
    published_version_id: "version-a",
    published_digest: "a".repeat(64),
  });
  admin.insertOperation(op);

  const result = await admin.admin.rpc("skill_publication_transition", {
    p_publication_id: op.id,
    p_expected_states: ["attaching"],
    p_next_state: "attaching",
    p_patch: { publishedVersionId: "version-a", attemptCount: 1 },
  });

  expect(result.error).toBeNull();
  expect(admin.getOperation(op.id).attempt_count).toBe(1);
}

async function allowsFirstReceipt(): Promise<void> {
  const admin = createRecoveryAdmin();
  const op = baseRecoveryOperationRow({ state: "publishing" });
  admin.insertOperation(op);

  const result = await admin.admin.rpc("skill_publication_transition", {
    p_publication_id: op.id,
    p_expected_states: ["publishing"],
    p_next_state: "attaching",
    p_patch: { publishedVersionId: "version-a" },
  });

  expect(result.error).toBeNull();
}

function refusesSecondLiveOperation(): void {
  const admin = createRecoveryAdmin();
  const draftId = "draft-shared";
  admin.insertOperation(
    baseRecoveryOperationRow({ draft_id: draftId, state: "preparing" }),
  );

  expect(() =>
    admin.insertOperation(
      baseRecoveryOperationRow({ draft_id: draftId, state: "preparing" }),
    ),
  ).toThrow(/one_live_per_draft/);
}

function allowsSecondAfterFirstFailed(): void {
  const admin = createRecoveryAdmin();
  const draftId = "draft-shared-2";
  admin.insertOperation(
    baseRecoveryOperationRow({ draft_id: draftId, state: "failed" }),
  );

  expect(() =>
    admin.insertOperation(
      baseRecoveryOperationRow({ draft_id: draftId, state: "preparing" }),
    ),
  ).not.toThrow();
}

describe("fake persistence rules", () => {
  it("refuses to change a populated published receipt", refusesReceiptChange);
  it(
    "refuses a skill-id-only change to a populated published receipt",
    refusesSkillIdOnlyChange,
  );
  it(
    "refuses a digest-only change to a populated published receipt",
    refusesDigestOnlyChange,
  );
  it(
    "allows a patch that repeats the same published receipt",
    allowsRepeatingSameReceipt,
  );
  it("allows setting a receipt for the first time", allowsFirstReceipt);
  it(
    "refuses a second non-failed operation for the same draft",
    refusesSecondLiveOperation,
  );
  it(
    "allows a second operation for the same draft once the first failed",
    allowsSecondAfterFirstFailed,
  );
});
