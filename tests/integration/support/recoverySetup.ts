import { createRecoveryAdmin, type RecoveryAdmin } from "./recoveryAdmin";
import { recoveryDeps } from "./recoveryDeps";
import { baseRecoveryOperationRow } from "./recoveryOperationRow";
import type { FakeOperationRow } from "./recoveryAdminState";
import {
  RECOVERY_CANDIDATE_ID,
  RECOVERY_CANDIDATE_NAME,
  RECOVERY_DEAL_ID,
  RECOVERY_OTHER_DEAL_ID,
  RECOVERY_TENANT_ID,
} from "./recoveryFixtures";

export type RecoveryCase = {
  admin: RecoveryAdmin;
  op: FakeOperationRow;
};

function seedDealsAndCandidate(admin: RecoveryAdmin): void {
  admin.insertDeal(RECOVERY_DEAL_ID, { tenant_id: RECOVERY_TENANT_ID });
  admin.insertDeal(RECOVERY_OTHER_DEAL_ID, { tenant_id: RECOVERY_TENANT_ID });
  admin.insertCandidate(RECOVERY_CANDIDATE_ID, RECOVERY_CANDIDATE_NAME);
}

export function newRecoveryCase(
  overrides: Partial<FakeOperationRow> = {},
): RecoveryCase {
  const admin = createRecoveryAdmin();
  seedDealsAndCandidate(admin);
  const op = baseRecoveryOperationRow(overrides);
  admin.insertOperation(op);
  return { admin, op };
}

export { recoveryDeps };
