import { checkAuthorization } from "./processorAuth";
import { buildComparisonSetOrPause } from "./processorComparisonSet";
import { normalizedNameCollision } from "./processorDuplicates";
import { fetchDealTenantId, fetchDraftBasisStepId } from "./processorRead";
import {
  backoffSecondsFor,
  retryAtSeconds,
  MAX_PUBLISH_ATTEMPTS,
  PAUSE_RETRY_SECONDS,
} from "./processorTiming";
import { pauseClearPatch, transitionResult } from "./processorTransition";
import type { PublicationReceipt, PublishRequest } from "./types";
import type {
  AdvanceResult,
  OperationRow,
  ProcessorDeps,
  SkillPublicationClientResult,
} from "./processorTypes";

async function pauseState(
  deps: ProcessorDeps,
  op: OperationRow,
  code: "access_lost" | "feature_disabled",
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "publishing", "publishing", {
    statusCode: code,
    nextRetryAt: retryAtSeconds(now, PAUSE_RETRY_SECONDS),
    correlationId: deps.correlationId(),
  });
}

async function buildPublishRequest(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<PublishRequest> {
  const tenantId = await fetchDealTenantId(deps.admin, op.deal_id);
  return {
    preparationId: op.preparation_id as string,
    assessmentDigest: op.assessment_digest as string,
    candidateId: op.provider_candidate_id,
    candidateDigest: op.candidate_digest,
    reservedSkillId: op.reserved_skill_id,
    companyId: tenantId,
    projectId: op.deal_id,
  };
}

async function stayPublishing(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "publishing", "publishing", {
    ...pauseClearPatch(op),
    attemptCount,
    nextRetryAt: retryAtSeconds(now, backoffSecondsFor(attemptCount)),
    correlationId: deps.correlationId(),
  });
}

async function toReconciling(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "publishing", "reconciling", {
    ...pauseClearPatch(op),
    attemptCount,
    nextRetryAt: retryAtSeconds(now, backoffSecondsFor(attemptCount)),
    correlationId: deps.correlationId(),
  });
}

async function toFailed(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
  statusCode: string,
  dealStepId: string | null,
): Promise<AdvanceResult> {
  return transitionResult(deps.admin, op.id, "publishing", "failed", {
    ...pauseClearPatch(op),
    attemptCount,
    statusCode,
    statusDealStepId: dealStepId,
    correlationId: deps.correlationId(),
  });
}

async function mapPublishOutcome(
  deps: ProcessorDeps,
  op: OperationRow,
  outcome: SkillPublicationClientResult<PublicationReceipt>,
  attemptCount: number,
): Promise<AdvanceResult> {
  if (outcome.outcome === "success") {
    return transitionResult(deps.admin, op.id, "publishing", "attaching", {
      ...pauseClearPatch(op),
      attemptCount,
      publishedSkillId: outcome.body.skillId,
      publishedVersionId: outcome.body.versionId,
      publishedDigest: outcome.body.digest,
      correlationId: deps.correlationId(),
    });
  }
  if (
    outcome.outcome === "timeout_or_network" ||
    outcome.outcome === "invalid_response"
  ) {
    return toReconciling(deps, op, attemptCount);
  }
  if (outcome.outcome === "http_error") {
    if (outcome.status === 409) return toReconciling(deps, op, attemptCount);
    if (outcome.status === 404 || outcome.status === 422) {
      return toFailed(deps, op, attemptCount, "candidate_invalid", null);
    }
  }
  return stayPublishing(deps, op, attemptCount);
}

async function backToPreparing(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  return transitionResult(deps.admin, op.id, "publishing", "preparing", {
    ...pauseClearPatch(op),
    nextRetryAt: null,
    correlationId: deps.correlationId(),
  });
}

async function callPublish(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  // Only reached after a publish is known not to have landed (first attempt,
  // a retryable error, or a reconcile that proved not-published), so failing
  // here cannot strand a published skill.
  if (op.attempt_count >= MAX_PUBLISH_ATTEMPTS) {
    return toFailed(deps, op, op.attempt_count, "publish_exhausted", null);
  }
  const request = await buildPublishRequest(deps, op);
  const attemptCount = op.attempt_count + 1;
  const outcome = await deps.ignatious.publish(op.id, request, {
    correlationId: deps.correlationId(),
  });
  return mapPublishOutcome(deps, op, outcome, attemptCount);
}

export async function advancePublishing(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  const auth = await checkAuthorization(deps, op);
  if (!auth.authorized) {
    return pauseState(deps, op, auth.code);
  }

  const comparisonSet = await buildComparisonSetOrPause(deps, op, "publishing");
  if (comparisonSet.kind === "integrity_error") return comparisonSet.result;

  if (comparisonSet.comparisonSetDigest !== op.comparison_set_digest) {
    return backToPreparing(deps, op);
  }

  const basisStepId = await fetchDraftBasisStepId(deps.admin, op.draft_id);
  const collision = normalizedNameCollision(
    op.name,
    comparisonSet.targets.filter(
      (target) => basisStepId === null || target.targetId !== basisStepId,
    ),
  );
  if (collision) {
    return toFailed(
      deps,
      op,
      op.attempt_count,
      collision.code,
      collision.dealStepId,
    );
  }

  return callPublish(deps, op);
}
