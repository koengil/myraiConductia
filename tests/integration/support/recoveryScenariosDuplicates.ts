import { expect } from "vitest";
import { createPublicationProcessor } from "@/lib/skillPublication/processor";
import { newRecoveryCase, recoveryDeps } from "./recoverySetup";
import { seedPublishedTarget } from "./recoveryTargets";
import {
  RECOVERY_DEAL_ID,
  recoveryCapabilityContract,
  similarCapabilityContract,
} from "./recoveryFixtures";

export async function normalFlow(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const processor = createPublicationProcessor(
    recoveryDeps({ admin: admin.admin }),
  );

  const result = await processor.drivePublication(op.id, 6);

  expect(result).toEqual({
    publicationId: op.id,
    state: "published",
    progressed: true,
  });
  const row = admin.getOperation(op.id);
  expect(row.resulting_deal_step_id).not.toBeNull();
  expect(row.published_skill_id).toBe(row.reserved_skill_id);
}

export async function weakMatchThenChangedSet(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const target = seedPublishedTarget(
    admin,
    RECOVERY_DEAL_ID,
    similarCapabilityContract(),
  );
  const processor = createPublicationProcessor(
    recoveryDeps({ admin: admin.admin }),
  );

  const paused = await processor.advancePublication(op.id);
  expect(paused.state).toBe("confirmation_required");

  admin.patchOperation(op.id, { state: "publishing" });
  admin.setDealStepRemoved(target.stepId, "2026-01-05T00:00:00.000Z");

  const revisited = await processor.advancePublication(op.id);
  expect(revisited.state).toBe("preparing");
}

export async function exactActiveDuplicate(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const target = seedPublishedTarget(
    admin,
    RECOVERY_DEAL_ID,
    recoveryCapabilityContract(),
  );
  const processor = createPublicationProcessor(
    recoveryDeps({ admin: admin.admin }),
  );

  const blocked = await processor.advancePublication(op.id);

  expect(blocked.state).toBe("failed");
  const row = admin.getOperation(op.id);
  expect(row.status_code).toBe("duplicate_active");
  expect(row.status_deal_step_id).toBe(target.stepId);
}

export async function exactRemovedDuplicate(): Promise<void> {
  const { admin, op } = newRecoveryCase();
  const target = seedPublishedTarget(
    admin,
    RECOVERY_DEAL_ID,
    recoveryCapabilityContract(),
    {
      removed: true,
    },
  );
  const processor = createPublicationProcessor(
    recoveryDeps({ admin: admin.admin }),
  );

  const blocked = await processor.advancePublication(op.id);

  expect(blocked.state).toBe("failed");
  const row = admin.getOperation(op.id);
  expect(row.status_code).toBe("duplicate_removed");
  expect(row.status_deal_step_id).toBe(target.stepId);
}
