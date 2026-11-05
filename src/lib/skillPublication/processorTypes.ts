import type { SupabaseClient } from "@supabase/supabase-js";
import type { SkillPublicationClientResult } from "./ignatiousClient";
import type {
  ComparisonTarget,
  PrepareRequest,
  PreparationReceipt,
  PublishRequest,
  PublicationReceipt,
  PublicationLookup,
  PublicationState,
} from "./types";

export type { SkillPublicationClientResult } from "./ignatiousClient";

export type AdvanceResult = {
  publicationId: string;
  state: PublicationState;
  progressed: boolean;
};

export type IgnatiousClientFunctions = {
  prepare: (
    operationId: string,
    body: PrepareRequest,
    context: { correlationId: string },
  ) => Promise<SkillPublicationClientResult<PreparationReceipt>>;
  publish: (
    operationId: string,
    body: PublishRequest,
    context: { correlationId: string },
  ) => Promise<SkillPublicationClientResult<PublicationReceipt>>;
  lookup: (
    operationId: string,
    context: { correlationId: string },
  ) => Promise<SkillPublicationClientResult<PublicationLookup>>;
};

export type BuildComparisonSetFn = (
  admin: SupabaseClient,
  args: { dealId: string; operationId: string },
) => Promise<{
  targets: ComparisonTarget[];
  comparisonSetDigest: string;
}>;

export type IsFlagEnabledFn = (key: "skill_authoring") => Promise<boolean>;

export type ProcessorDeps = {
  admin: SupabaseClient;
  ignatious: IgnatiousClientFunctions;
  buildComparisonSet: BuildComparisonSetFn;
  isFlagEnabled: IsFlagEnabledFn;
  now: () => Date;
  correlationId: () => string;
};

export type OperationRow = {
  id: string;
  deal_id: string;
  draft_id: string;
  actor_id: string;
  state: PublicationState;
  candidate_id: string;
  provider_candidate_id: string;
  candidate_digest: string;
  name: string;
  capability_contract: unknown;
  comparison_set_digest: string | null;
  preparation_id: string | null;
  assessment_digest: string | null;
  reserved_skill_id: string;
  status_code: string | null;
  next_retry_at: string | null;
  attempt_count: number;
};

export type TransitionPatch = {
  statusCode?: string | null;
  statusDealStepId?: string | null;
  nextRetryAt?: string | null;
  attemptCount?: number;
  comparisonSetDigest?: string;
  preparationId?: string;
  assessmentDigest?: string;
  duplicateMatches?: unknown;
  publishedSkillId?: string;
  publishedVersionId?: string;
  publishedDigest?: string;
  correlationId?: string;
};
