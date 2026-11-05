import { expect } from "vitest";
import { advanceAttaching } from "@/lib/skillPublication/processorAttach";
import { lookup as ignatiousLookup } from "@/lib/skillPublication/ignatiousClient";
import { createAdvancingClock } from "./recoveryClock";
import { clockedDeps, clockedProcessor } from "./recoveryScenarioHelpers";
import { newRecoveryCase, recoveryDeps } from "./recoverySetup";
import { createPublicationProcessor } from "@/lib/skillPublication/processor";

export function secondsPastRetry(
  clock: ReturnType<typeof createAdvancingClock>,
  nextRetryAt: string,
): number {
  const remainingMs = new Date(nextRetryAt).getTime() - clock.now().getTime();
  return Math.ceil(remainingMs / 1000) + 1;
}

async function committedVersionId(operationId: string): Promise<string> {
  const committed = await ignatiousLookup(operationId, {
    correlationId: "verify-server-committed",
  });
  if (
    committed.outcome !== "success" ||
    committed.body.status !== "published"
  ) {
    throw new Error("expected the real server to have committed the publish");
  }
  return committed.body.publication.versionId;
}

async function recoverWithoutRepublishing(
  admin: ReturnType<typeof newRecoveryCase>["admin"],
  clock: ReturnType<typeof createAdvancingClock>,
  opId: string,
  committed: string,
): Promise<void> {
  const nextRetryAt = admin.getOperation(opId).next_retry_at;
  if (nextRetryAt === null) {
    throw new Error("expected the lost publish reply to defer the retry");
  }
  const guarded = clockedProcessor(admin, clock, {
    faultPlan: { forbid: new Set(["publish"]) },
  });

  const tooSoon = await guarded.drivePublication(opId, 2);
  expect(tooSoon).toEqual({
    publicationId: opId,
    state: "reconciling",
    progressed: false,
  });

  clock.advanceSeconds(secondsPastRetry(clock, nextRetryAt));

  const recovered = await guarded.drivePublication(opId, 3);
  expect(recovered.state).toBe("published");
  expect(admin.getOperation(opId).published_version_id).toBe(committed);
}

export async function lostPublishResponse(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const clock = createAdvancingClock();
  const processor = clockedProcessor(admin, clock);
  const toPublishing = await processor.advancePublication(op.id);
  expect(toPublishing.state).toBe("publishing");

  const faultyProcessor = clockedProcessor(admin, clock, {
    faultPlan: { dropReplyOnce: new Set(["publish"]) },
  });
  const lost = await faultyProcessor.advancePublication(op.id);
  expect(lost.state).toBe("reconciling");
  const committed = await committedVersionId(op.id);

  const deferred = await processor.drivePublication(op.id, 4);
  expect(deferred).toEqual({
    publicationId: op.id,
    state: "reconciling",
    progressed: false,
  });

  await recoverWithoutRepublishing(admin, clock, op.id, committed);

  const fresh = await processor.advancePublication(op.id);
  expect(fresh).toEqual({
    publicationId: op.id,
    state: "published",
    progressed: false,
  });
}

export async function transientAttachFailure(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const deps = recoveryDeps({ admin: admin.admin });
  const processor = createPublicationProcessor(deps);
  await processor.drivePublication(op.id, 2);
  expect(admin.getOperation(op.id).state).toBe("attaching");

  admin.failNextAttach(1);
  const retried = await processor.advancePublication(op.id);
  expect(retried).toEqual({
    publicationId: op.id,
    state: "attaching",
    progressed: true,
  });

  const published = await processor.advancePublication(op.id);
  expect(published.state).toBe("published");
  expect(admin.dealStepsForRequest(op.id)).toHaveLength(1);
}

export async function lostAttachResponse(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const clock = createAdvancingClock();
  const deps = clockedDeps(admin, clock);
  const processor = createPublicationProcessor(deps);
  await processor.drivePublication(op.id, 2);
  const attachingSnapshot = admin.getOperation(op.id);
  expect(attachingSnapshot.state).toBe("attaching");

  admin.loseNextAttachReply();
  const lost = await advanceAttaching(deps, attachingSnapshot);
  expect(lost.state).toBe("attaching");
  const afterLost = admin.getOperation(op.id);
  expect(afterLost.state).toBe("attaching");
  expect(afterLost.next_retry_at).not.toBeNull();
  expect(admin.dealStepsForRequest(op.id)).toHaveLength(1);
  const committedStepId = admin.dealStepsForRequest(op.id)[0]?.id;

  const tooSoon = await processor.drivePublication(op.id, 2);
  expect(tooSoon).toEqual({
    publicationId: op.id,
    state: "attaching",
    progressed: false,
  });

  clock.advanceSeconds(
    secondsPastRetry(clock, afterLost.next_retry_at as string),
  );

  const retried = await processor.drivePublication(op.id, 2);
  expect(retried.state).toBe("published");
  expect(admin.getOperation(op.id).resulting_deal_step_id).toBe(
    committedStepId,
  );
  expect(admin.dealStepsForRequest(op.id)).toHaveLength(1);
}
