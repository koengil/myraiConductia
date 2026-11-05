import { expect } from "vitest";
import { createPublicationProcessor } from "@/lib/skillPublication/processor";
import { createAdvancingClock } from "./recoveryClock";
import { baseRecoveryOperationRow } from "./recoveryOperationRow";
import { secondsPastRetry } from "./recoveryScenariosRecovery";
import { clockedProcessor } from "./recoveryScenarioHelpers";
import { newRecoveryCase, recoveryDeps } from "./recoverySetup";
import { seedPublishedTarget } from "./recoveryTargets";
import {
  RECOVERY_DEAL_ID,
  RECOVERY_OTHER_DEAL_ID,
  recoveryCapabilityContract,
} from "./recoveryFixtures";

function anchorContract() {
  return {
    purpose: "Draft the closing checklist.",
    expectedInput: "Open items.",
    expectedOutput: "A checklist.",
  };
}

function replacementContract() {
  return {
    purpose: "Draft the diligence tracker.",
    expectedInput: "Open requests.",
    expectedOutput: "A tracker.",
  };
}

function replacePlacement(
  admin: ReturnType<typeof newRecoveryCase>["admin"],
  opId: string,
  stepId: string,
): void {
  admin.patchOperation(opId, {
    state: "attaching",
    anchor_deal_step_id: stepId,
    status_code: null,
  });
}

export async function removedAnchorThenReplacement(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const anchor = seedPublishedTarget(admin, RECOVERY_DEAL_ID, anchorContract());
  admin.patchOperation(op.id, {
    placement_kind: "after",
    anchor_deal_step_id: anchor.stepId,
  });
  const processor = createPublicationProcessor(
    recoveryDeps({ admin: admin.admin }),
  );
  await processor.drivePublication(op.id, 2);
  expect(admin.getOperation(op.id).state).toBe("attaching");
  const versionBefore = admin.getOperation(op.id).published_version_id;

  admin.setDealStepRemoved(anchor.stepId, "2026-02-01T00:00:00.000Z");
  const anchorRemoved = await processor.advancePublication(op.id);
  expect(anchorRemoved.state).toBe("needs_placement");
  expect(admin.getOperation(op.id).status_code).toBe("anchor_removed");

  const replacement = seedPublishedTarget(
    admin,
    RECOVERY_DEAL_ID,
    replacementContract(),
  );
  replacePlacement(admin, op.id, replacement.stepId);
  const attached = await processor.advancePublication(op.id);
  expect(attached.state).toBe("published");
  expect(admin.getOperation(op.id).published_version_id).toBe(versionBefore);
}

export async function permissionLoss(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const clock = createAdvancingClock();
  const processor = clockedProcessor(admin, clock);

  admin.setAuthError({ code: "42501" });
  const paused = await processor.advancePublication(op.id);
  expect(paused.state).toBe("preparing");
  expect(admin.getOperation(op.id).status_code).toBe("access_lost");
  expect(admin.getOperation(op.id).next_retry_at).not.toBeNull();

  const deferred = await processor.drivePublication(op.id, 6);
  expect(deferred).toEqual({
    publicationId: op.id,
    state: "preparing",
    progressed: false,
  });

  admin.setAuthError(null);
  clock.advanceSeconds(301);
  const toAttaching = await processor.drivePublication(op.id, 2);
  expect(toAttaching.state).toBe("attaching");

  admin.setAuthError({ code: "42501" });
  const published = await processor.advancePublication(op.id);
  expect(published.state).toBe("published");

  const noOp = await processor.advancePublication(op.id);
  expect(noOp).toEqual({
    publicationId: op.id,
    state: "published",
    progressed: false,
  });
}

async function pauseThenAdvanceClock(
  admin: ReturnType<typeof newRecoveryCase>["admin"],
  op: ReturnType<typeof newRecoveryCase>["op"],
  clock: ReturnType<typeof createAdvancingClock>,
  processor: ReturnType<typeof clockedProcessor>,
): Promise<void> {
  const paused = await processor.advancePublication(op.id);
  expect(paused.state).toBe("preparing");
  expect(admin.getOperation(op.id).status_code).toBe("feature_disabled");

  const deferred = await processor.drivePublication(op.id, 6);
  expect(deferred).toEqual({
    publicationId: op.id,
    state: "preparing",
    progressed: false,
  });
  clock.advanceSeconds(301);
}

export async function featureDisabled(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const clock = createAdvancingClock();
  let flagEnabled = false;
  const isFlagEnabled = async () => flagEnabled;
  const processor = clockedProcessor(admin, clock, { isFlagEnabled });

  await pauseThenAdvanceClock(admin, op, clock, processor);
  flagEnabled = true;
  const toPublishing = await processor.advancePublication(op.id);
  expect(toPublishing.state).toBe("publishing");

  const faultyProcessor = clockedProcessor(admin, clock, {
    faultPlan: { dropReplyOnce: new Set(["publish"]) },
    isFlagEnabled,
  });
  const lost = await faultyProcessor.advancePublication(op.id);
  expect(lost.state).toBe("reconciling");
  const nextRetryAt = admin.getOperation(op.id).next_retry_at;
  if (nextRetryAt === null) {
    throw new Error("expected the lost publish reply to defer the retry");
  }

  flagEnabled = false;
  const tooSoon = await processor.drivePublication(op.id, 2);
  expect(tooSoon).toEqual({
    publicationId: op.id,
    state: "reconciling",
    progressed: false,
  });

  clock.advanceSeconds(secondsPastRetry(clock, nextRetryAt));

  const recovered = await processor.drivePublication(op.id, 3);
  expect(recovered.state).toBe("published");
}

export async function crossProjectNameIsolation(): Promise<void> {
  const { admin, op: opA } = newRecoveryCase();
  const opB = baseRecoveryOperationRow({
    deal_id: RECOVERY_OTHER_DEAL_ID,
    name: opA.name,
    capability_contract: recoveryCapabilityContract(),
  });
  admin.insertOperation(opB);
  const processor = createPublicationProcessor(
    recoveryDeps({ admin: admin.admin }),
  );

  const publishedB = await processor.drivePublication(opB.id, 6);
  expect(publishedB).toEqual({
    publicationId: opB.id,
    state: "published",
    progressed: true,
  });

  const publishedA = await processor.drivePublication(opA.id, 6);
  expect(publishedA).toEqual({
    publicationId: opA.id,
    state: "published",
    progressed: true,
  });

  const rowA = admin.getOperation(opA.id);
  const rowB = admin.getOperation(opB.id);
  expect(rowA.published_skill_id).not.toBe(rowB.published_skill_id);
  expect(rowA.status_code).toBeNull();
}
