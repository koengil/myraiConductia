import type { Placement } from "@/lib/skillAuthoring/types";

export const PUBLICATION_STATES = [
  "preparing",
  "confirmation_required",
  "publishing",
  "attaching",
  "reconciling",
  "needs_placement",
  "published",
  "failed",
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];
export const FAILED_PUBLICATION_STATE: PublicationState = "failed";

export const DUPLICATE_CLASSIFICATIONS = [
  "exact",
  "equivalent",
  "similar",
] as const;
export type DuplicateClassification =
  (typeof DUPLICATE_CLASSIFICATIONS)[number];

export const DUPLICATE_REASON_CODES = [
  "identity_match",
  "name_match",
  "contract_match",
  "capability_equivalent",
  "capability_similar",
] as const;
export type DuplicateReasonCode = (typeof DUPLICATE_REASON_CODES)[number];

export const COMPARISON_TARGET_STATES = [
  "active",
  "removed",
  "admitted",
] as const;
export type ComparisonTargetState = (typeof COMPARISON_TARGET_STATES)[number];

export const PUBLICATION_ERROR_CODES = [
  "candidate_invalid",
  "candidate_stale",
  "duplicate_active",
  "duplicate_removed",
  "duplicate_declined",
  "access_lost",
  "feature_disabled",
  "anchor_removed",
  "receipt_conflict",
  "step_removed",
  "publish_exhausted",
] as const;
export type PublicationErrorCode = (typeof PUBLICATION_ERROR_CODES)[number];

export const PUBLICATION_CONFLICT_CODES = [
  "idempotency_conflict",
  "stale_edit_revision",
  "stale_candidate",
  "generation_active",
  "publication_exists",
  "stale_publication_revision",
  "assessment_mismatch",
  "placement_not_allowed",
] as const;
export type PublicationConflictCode =
  (typeof PUBLICATION_CONFLICT_CODES)[number];

export type SkillBinding = {
  skillId: string;
  versionId: string;
  digest: string;
};

export type SkillStepDefinitionV1 = {
  schemaVersion: 1;
  type: "skill";
  title: string;
  description: string;
  inputs: [
    {
      key: "primary";
      kind: "text";
      label: "Input";
      helperText: string;
      required: true;
    },
  ];
  skillBinding: SkillBinding;
};

export type PublishCommand = {
  requestId: string;
  expectedEditRevision: number;
  candidateId: string;
  candidateDigest: string;
};

export type DuplicateDecisionCommand = {
  expectedRevision: number;
  assessmentDigest: string;
  decision: "confirm" | "decline";
};

export type PlacementCommand = {
  expectedRevision: number;
  placement: Placement;
};

export type CapabilityContract = {
  purpose: string;
  expectedInput: string;
  expectedOutput: string;
};

export type ComparisonTargetCandidate = {
  candidateId: string;
  candidateDigest: string;
};

export type ComparisonTarget = {
  targetId: string;
  state: ComparisonTargetState;
  displayName: string;
  capabilityContract: CapabilityContract;
  skillBinding: SkillBinding | null;
  candidate: ComparisonTargetCandidate | null;
};

export type DuplicateMatch = {
  targetId: string;
  classification: DuplicateClassification;
  reasonCode: DuplicateReasonCode;
  confidence: number;
};

export type SafeDuplicateMatch = {
  dealStepId: string | null;
  name: string;
  classification: DuplicateClassification;
  reasonCode: DuplicateReasonCode;
};

export type PrepareRequest = {
  candidateId: string;
  candidateDigest: string;
  candidateName: string;
  reservedSkillId: string;
  companyId: string;
  projectId: string;
  displayName: string;
  capabilityContract: CapabilityContract;
  comparisonSetDigest: string;
  targets: ComparisonTarget[];
  ancestorSkillId?: string;
};

export type PreparationReceipt = {
  operationId: string;
  preparationId: string;
  candidateDigest: string;
  capabilityContract: CapabilityContract;
  comparisonSetDigest: string;
  assessmentDigest: string;
  matches: DuplicateMatch[];
};

export type PublishRequest = {
  preparationId: string;
  assessmentDigest: string;
  candidateId: string;
  candidateDigest: string;
  reservedSkillId: string;
  companyId: string;
  projectId: string;
};

export type PublicationReceipt = {
  operationId: string;
  skillId: string;
  versionId: string;
  digest: string;
  projectId: string;
  publishedAt: string;
};

export type PublicationLookup =
  | { status: "not_published" }
  | { status: "prepared"; preparation: PreparationReceipt }
  | { status: "published"; publication: PublicationReceipt };

export type PublicationError = {
  code: PublicationErrorCode;
  dealStepId: string | null;
};

export type PublicationResult = {
  stepId: string;
  skillBinding: SkillBinding;
};

export type PublicationRead = {
  available: true;
  id: string;
  state: PublicationState;
  revision: number;
  matches: SafeDuplicateMatch[];
  error: PublicationError | null;
  result: PublicationResult | null;
  assessmentDigest: string | null;
};
