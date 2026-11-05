import type { CapabilityContract } from "@/lib/skillPublication/types";
import type { RecoveryAdmin } from "./recoveryAdmin";
import { baseRecoveryOperationRow } from "./recoveryOperationRow";
import { nextRecoveryUuid, skillStepDefinition } from "./recoveryFixtures";

export type PublishedTarget = {
  stepId: string;
  skillId: string;
  versionId: string;
  digest: string;
};

type TargetOptions = { removed?: boolean; name?: string };

function insertTargetOperation(
  admin: RecoveryAdmin,
  dealId: string,
  contract: CapabilityContract,
  name: string,
  target: PublishedTarget,
): string {
  const op = baseRecoveryOperationRow({
    id: nextRecoveryUuid("14000000"),
    deal_id: dealId,
    state: "published",
    name,
    capability_contract: contract,
    published_skill_id: target.skillId,
    published_version_id: target.versionId,
    published_digest: target.digest,
    resulting_deal_step_id: target.stepId,
  });
  admin.insertOperation(op);
  return op.id;
}

function insertTargetStep(
  admin: RecoveryAdmin,
  dealId: string,
  contract: CapabilityContract,
  name: string,
  target: PublishedTarget,
  options: TargetOptions,
  requestId: string,
): void {
  admin.insertDealStep({
    id: target.stepId,
    deal_id: dealId,
    removed_at: options.removed ? "2026-01-01T00:00:00.000Z" : null,
    request_id: requestId,
    definition: skillStepDefinition(
      name,
      contract.purpose,
      contract.expectedInput,
      {
        skillId: target.skillId,
        versionId: target.versionId,
        digest: target.digest,
      },
    ),
  });
}

export function seedPublishedTarget(
  admin: RecoveryAdmin,
  dealId: string,
  contract: CapabilityContract,
  options: TargetOptions = {},
): PublishedTarget {
  const target: PublishedTarget = {
    skillId: nextRecoveryUuid("11000000"),
    versionId: nextRecoveryUuid("12000000"),
    digest: "b".repeat(64),
    stepId: nextRecoveryUuid("13000000"),
  };
  const name = options.name ?? "Existing published step";
  const requestId = insertTargetOperation(
    admin,
    dealId,
    contract,
    name,
    target,
  );
  insertTargetStep(admin, dealId, contract, name, target, options, requestId);
  return target;
}
