import type {
  CapabilityContract,
  ComparisonTarget,
  DuplicateMatch,
  PreparationReceipt,
  PublicationLookup,
  PublicationReceipt,
} from "@/lib/skillPublication/types";
import type { OperationRow } from "@/lib/skillPublication/processorTypes";

export const OPERATION_ID = "10000000-0000-4000-8000-000000000001";
export const DEAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const DRAFT_ID = "20000000-0000-4000-8000-000000000001";
export const ACTOR_ID = "30000000-0000-4000-8000-000000000001";
export const CANDIDATE_ID = "40000000-0000-4000-8000-000000000001";
export const PROVIDER_CANDIDATE_ID = "40000000-0000-4000-8000-000000000002";
export const RESERVED_SKILL_ID = "50000000-0000-4000-8000-000000000001";
export const TENANT_ID = "60000000-0000-4000-8000-000000000001";
export const SKILL_ID = "70000000-0000-4000-8000-000000000001";
export const VERSION_ID = "70000000-0000-4000-8000-000000000002";
export const STEP_ACTIVE = "80000000-0000-4000-8000-000000000001";
export const OTHER_STEP_ID = "80000000-0000-4000-8000-000000000009";
export const STEP_REMOVED = "80000000-0000-4000-8000-000000000002";
export const ADMITTED_OP_ID = "80000000-0000-4000-8000-000000000003";
export const PREPARATION_ID = "90000000-0000-4000-8000-000000000001";
export const RESULTING_STEP_ID = "80000000-0000-4000-8000-000000000004";

export const CANDIDATE_DIGEST =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
export const COMPARISON_SET_DIGEST =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
export const OTHER_COMPARISON_SET_DIGEST =
  "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const ASSESSMENT_DIGEST =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
export const PUBLISHED_DIGEST =
  "1111111111111111111111111111111111111111111111111111111111111a";

export const OPERATION_NAME = "Weekly project update";
export const CANDIDATE_NAME = "Weekly project update";
export const PUBLISHED_AT = "2026-09-11T00:00:00.000Z";
export const CORRELATION_ID = "corr-1";
export const NOW = new Date("2026-09-11T12:00:00.000Z");

const BASE_CAPABILITY_CONTRACT: CapabilityContract = {
  purpose: "Prepare a concise project update.",
  expectedInput: "The reporting period.",
  expectedOutput: "A concise project update.",
};

export function capabilityContract(): CapabilityContract {
  return { ...BASE_CAPABILITY_CONTRACT };
}

const BASE_OPERATION_ROW = {
  id: OPERATION_ID,
  deal_id: DEAL_ID,
  draft_id: DRAFT_ID,
  actor_id: ACTOR_ID,
  state: "preparing" as const,
  revision: 1,
  candidate_id: CANDIDATE_ID,
  provider_candidate_id: PROVIDER_CANDIDATE_ID,
  candidate_digest: CANDIDATE_DIGEST,
  name: OPERATION_NAME,
  capability_contract: BASE_CAPABILITY_CONTRACT,
  comparison_set_digest: null,
  preparation_id: null,
  assessment_digest: null,
  reserved_skill_id: RESERVED_SKILL_ID,
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

export function baseOperationRow(
  overrides: Partial<OperationRow> = {},
): OperationRow {
  return { ...BASE_OPERATION_ROW, ...overrides };
}

export function activeTarget(
  overrides: Partial<ComparisonTarget> = {},
): ComparisonTarget {
  return {
    targetId: STEP_ACTIVE,
    state: "active",
    displayName: "Other active step",
    capabilityContract: capabilityContract(),
    skillBinding: {
      skillId: SKILL_ID,
      versionId: VERSION_ID,
      digest: PUBLISHED_DIGEST,
    },
    candidate: null,
    ...overrides,
  };
}

export function removedTarget(
  overrides: Partial<ComparisonTarget> = {},
): ComparisonTarget {
  return {
    targetId: STEP_REMOVED,
    state: "removed",
    displayName: "Removed step",
    capabilityContract: capabilityContract(),
    skillBinding: {
      skillId: SKILL_ID,
      versionId: VERSION_ID,
      digest: PUBLISHED_DIGEST,
    },
    candidate: null,
    ...overrides,
  };
}

export function admittedTarget(
  overrides: Partial<ComparisonTarget> = {},
): ComparisonTarget {
  return {
    targetId: ADMITTED_OP_ID,
    state: "admitted",
    displayName: "Admitted operation",
    capabilityContract: capabilityContract(),
    skillBinding: null,
    candidate: {
      candidateId: PROVIDER_CANDIDATE_ID,
      candidateDigest: CANDIDATE_DIGEST,
    },
    ...overrides,
  };
}

export function duplicateMatch(
  overrides: Partial<DuplicateMatch> = {},
): DuplicateMatch {
  return {
    targetId: STEP_ACTIVE,
    classification: "similar",
    reasonCode: "capability_similar",
    confidence: 0.6,
    ...overrides,
  };
}

export function preparationReceipt(
  overrides: Partial<PreparationReceipt> = {},
): PreparationReceipt {
  return {
    operationId: OPERATION_ID,
    preparationId: PREPARATION_ID,
    candidateDigest: CANDIDATE_DIGEST,
    capabilityContract: capabilityContract(),
    comparisonSetDigest: COMPARISON_SET_DIGEST,
    assessmentDigest: ASSESSMENT_DIGEST,
    matches: [],
    ...overrides,
  };
}

export function publicationReceipt(
  overrides: Partial<PublicationReceipt> = {},
): PublicationReceipt {
  return {
    operationId: OPERATION_ID,
    skillId: RESERVED_SKILL_ID,
    versionId: VERSION_ID,
    digest: CANDIDATE_DIGEST,
    projectId: DEAL_ID,
    publishedAt: PUBLISHED_AT,
    ...overrides,
  };
}

export function publishedLookup(
  overrides: Partial<PublicationReceipt> = {},
): Extract<PublicationLookup, { status: "published" }> {
  return { status: "published", publication: publicationReceipt(overrides) };
}

export {
  createStatefulAdmin,
  fakeDeps,
  fakeIgnatious,
  type RpcCall,
  type StatefulAdminOptions,
} from "./skillPublicationProcessorAdmin";
