import type { SupabaseClient } from "@supabase/supabase-js";
import { isNonEmptyString } from "./parse";
import {
  fetchCandidateName,
  fetchDealTenantId,
  fetchDraftBasis,
} from "./processorRead";
import type {
  CapabilityContract,
  ComparisonTarget,
  PrepareRequest,
} from "./types";
import type { OperationRow } from "./processorTypes";

const CANDIDATE_NAME_MAX_LENGTH = 100;

export type PrepareRequestOutcome =
  { kind: "invalid_name" } | { kind: "ok"; request: PrepareRequest };

export async function buildPrepareRequest(
  admin: SupabaseClient,
  op: OperationRow,
  comparisonSetDigest: string,
  targets: ComparisonTarget[],
): Promise<PrepareRequestOutcome> {
  const candidateName = await fetchCandidateName(admin, op.candidate_id);
  if (!isNonEmptyString(candidateName, CANDIDATE_NAME_MAX_LENGTH)) {
    return { kind: "invalid_name" };
  }

  const tenantId = await fetchDealTenantId(admin, op.deal_id);
  const capabilityContract = op.capability_contract as CapabilityContract;
  const basis = await fetchDraftBasis(admin, op.draft_id);

  return {
    kind: "ok",
    request: {
      candidateId: op.provider_candidate_id,
      candidateDigest: op.candidate_digest,
      candidateName,
      reservedSkillId: op.reserved_skill_id,
      companyId: tenantId,
      projectId: op.deal_id,
      displayName: op.name,
      capabilityContract,
      comparisonSetDigest,
      targets,
      ...(basis?.kind === "publication" ? { ancestorSkillId: basis.skillId } : {}),
    },
  };
}
