import type { FakeOperationRow } from "./recoveryAdminState";
import {
  RECOVERY_ACTOR_ID,
  RECOVERY_CANDIDATE_DIGEST,
  RECOVERY_CANDIDATE_ID,
  RECOVERY_DEAL_ID,
  RECOVERY_PROVIDER_CANDIDATE_ID,
  nextRecoveryUuid,
  recoveryCapabilityContract,
} from "./recoveryFixtures";

const DEFAULT_ROW: Omit<
  FakeOperationRow,
  "id" | "draft_id" | "reserved_skill_id" | "reserved_step_key"
> = {
  deal_id: RECOVERY_DEAL_ID,
  actor_id: RECOVERY_ACTOR_ID,
  state: "preparing",
  revision: 1,
  candidate_id: RECOVERY_CANDIDATE_ID,
  provider_candidate_id: RECOVERY_PROVIDER_CANDIDATE_ID,
  candidate_digest: RECOVERY_CANDIDATE_DIGEST,
  name: "Weekly project update",
  capability_contract: recoveryCapabilityContract(),
  comparison_set_digest: null,
  preparation_id: null,
  assessment_digest: null,
  published_skill_id: null,
  published_version_id: null,
  published_digest: null,
  resulting_deal_step_id: null,
  phase_index: 0,
  placement_kind: "phase_end",
  anchor_deal_step_id: null,
  status_code: null,
  status_deal_step_id: null,
  next_retry_at: null,
  attempt_count: 0,
  duplicate_matches: null,
};

export function baseRecoveryOperationRow(
  overrides: Partial<FakeOperationRow> = {},
): FakeOperationRow {
  const id = overrides.id ?? nextRecoveryUuid("c0000000");
  const draftId = nextRecoveryUuid("d0000000");
  const reservedSkillId = nextRecoveryUuid("e0000000");
  const reservedStepKey = `custom:${nextRecoveryUuid("f0000000")}`;
  return {
    ...DEFAULT_ROW,
    draft_id: draftId,
    reserved_skill_id: reservedSkillId,
    reserved_step_key: reservedStepKey,
    ...overrides,
    id,
  };
}
