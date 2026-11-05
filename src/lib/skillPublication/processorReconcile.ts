import { checkAuthorization } from "./processorAuth";
import {
  backoffSecondsFor,
  retryAtSeconds,
  PAUSE_RETRY_SECONDS,
  RECEIPT_CONFLICT_RETRY_SECONDS,
} from "./processorTiming";
import { pauseClearPatch, transitionResult } from "./processorTransition";
import type { PublicationLookup } from "./types";
import type {
  AdvanceResult,
  OperationRow,
  ProcessorDeps,
  SkillPublicationClientResult,
} from "./processorTypes";

function receiptMatchesFrozenOperation(
  op: OperationRow,
  lookup: Extract<PublicationLookup, { status: "published" }>,
): boolean {
  return (
    lookup.publication.skillId === op.reserved_skill_id &&
    lookup.publication.digest === op.candidate_digest
  );
}

async function toAttaching(
  deps: ProcessorDeps,
  op: OperationRow,
  lookup: Extract<PublicationLookup, { status: "published" }>,
  attemptCount: number,
): Promise<AdvanceResult> {
  return transitionResult(deps.admin, op.id, "reconciling", "attaching", {
    ...pauseClearPatch(op),
    statusCode: null,
    attemptCount,
    publishedSkillId: lookup.publication.skillId,
    publishedVersionId: lookup.publication.versionId,
    publishedDigest: lookup.publication.digest,
    correlationId: deps.correlationId(),
  });
}

async function receiptConflict(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "reconciling", "reconciling", {
    ...pauseClearPatch(op),
    attemptCount,
    statusCode: "receipt_conflict",
    nextRetryAt: retryAtSeconds(now, RECEIPT_CONFLICT_RETRY_SECONDS),
    correlationId: deps.correlationId(),
  });
}

async function stayReconciling(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "reconciling", "reconciling", {
    ...pauseClearPatch(op),
    attemptCount,
    nextRetryAt: retryAtSeconds(now, backoffSecondsFor(attemptCount)),
    correlationId: deps.correlationId(),
  });
}

async function backToPublishing(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
): Promise<AdvanceResult> {
  return transitionResult(deps.admin, op.id, "reconciling", "publishing", {
    ...pauseClearPatch(op),
    attemptCount,
    nextRetryAt: null,
    correlationId: deps.correlationId(),
  });
}

async function pauseReconciling(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
  code: "access_lost" | "feature_disabled",
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "reconciling", "reconciling", {
    attemptCount,
    statusCode: code,
    nextRetryAt: retryAtSeconds(now, PAUSE_RETRY_SECONDS),
    correlationId: deps.correlationId(),
  });
}

async function handleProvenNotPublished(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
): Promise<AdvanceResult> {
  const auth = await checkAuthorization(deps, op);
  if (!auth.authorized) {
    return pauseReconciling(deps, op, attemptCount, auth.code);
  }
  return backToPublishing(deps, op, attemptCount);
}

async function mapLookupOutcome(
  deps: ProcessorDeps,
  op: OperationRow,
  outcome: SkillPublicationClientResult<PublicationLookup>,
  attemptCount: number,
): Promise<AdvanceResult> {
  if (outcome.outcome !== "success") {
    return stayReconciling(deps, op, attemptCount);
  }
  const lookup = outcome.body;
  if (lookup.status === "published") {
    return receiptMatchesFrozenOperation(op, lookup)
      ? toAttaching(deps, op, lookup, attemptCount)
      : receiptConflict(deps, op, attemptCount);
  }
  return handleProvenNotPublished(deps, op, attemptCount);
}

export async function advanceReconciling(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  const attemptCount = op.attempt_count + 1;
  const outcome = await deps.ignatious.lookup(op.id, {
    correlationId: deps.correlationId(),
  });
  return mapLookupOutcome(deps, op, outcome, attemptCount);
}
