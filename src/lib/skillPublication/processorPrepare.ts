import { checkAuthorization } from "./processorAuth";
import { buildComparisonSetOrPause } from "./processorComparisonSet";
import { decideDuplicates } from "./processorDuplicates";
import {
  buildPrepareRequest,
  type PrepareRequestOutcome,
} from "./processorPrepareRequest";
import {
  PAUSE_RETRY_SECONDS,
  backoffSecondsFor,
  retryAtSeconds,
} from "./processorTiming";
import { pauseClearPatch, transitionResult } from "./processorTransition";
import type { ComparisonTarget, PreparationReceipt } from "./types";
import type {
  AdvanceResult,
  OperationRow,
  ProcessorDeps,
  SkillPublicationClientResult,
} from "./processorTypes";

function preparationPatchBase(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
) {
  return {
    ...pauseClearPatch(op),
    attemptCount,
    correlationId: deps.correlationId(),
  };
}

async function blockOnDuplicate(
  deps: ProcessorDeps,
  op: OperationRow,
  block: { code: string; dealStepId: string | null },
  attemptCount: number,
): Promise<AdvanceResult> {
  return transitionResult(deps.admin, op.id, "preparing", "failed", {
    ...preparationPatchBase(deps, op, attemptCount),
    statusCode: block.code,
    statusDealStepId: block.dealStepId,
  });
}

async function pauseForConfirmation(
  deps: ProcessorDeps,
  op: OperationRow,
  receipt: PreparationReceipt,
  matches: unknown,
  attemptCount: number,
): Promise<AdvanceResult> {
  return transitionResult(
    deps.admin,
    op.id,
    "preparing",
    "confirmation_required",
    {
      ...preparationPatchBase(deps, op, attemptCount),
      // Publishing gets its own budget (MAX_PUBLISH_ATTEMPTS): preparation
      // retries must not spend it (#249).
      attemptCount: 0,
      duplicateMatches: matches,
      preparationId: receipt.preparationId,
      assessmentDigest: receipt.assessmentDigest,
      comparisonSetDigest: receipt.comparisonSetDigest,
    },
  );
}

async function clearToPublishing(
  deps: ProcessorDeps,
  op: OperationRow,
  receipt: PreparationReceipt,
  attemptCount: number,
): Promise<AdvanceResult> {
  return transitionResult(deps.admin, op.id, "preparing", "publishing", {
    ...preparationPatchBase(deps, op, attemptCount),
    // Publishing gets its own budget (MAX_PUBLISH_ATTEMPTS): preparation
    // retries must not spend it (#249).
    attemptCount: 0,
    preparationId: receipt.preparationId,
    assessmentDigest: receipt.assessmentDigest,
    comparisonSetDigest: receipt.comparisonSetDigest,
  });
}

async function applyDuplicatePolicy(
  deps: ProcessorDeps,
  op: OperationRow,
  receipt: PreparationReceipt,
  targets: ComparisonTarget[],
  attemptCount: number,
): Promise<AdvanceResult> {
  const decision = decideDuplicates(receipt.matches, targets);
  if (decision.kind === "block") {
    return blockOnDuplicate(deps, op, decision.block, attemptCount);
  }
  if (decision.kind === "confirm") {
    return pauseForConfirmation(
      deps,
      op,
      receipt,
      decision.matches,
      attemptCount,
    );
  }
  return clearToPublishing(deps, op, receipt, attemptCount);
}

function isTerminalPrepareFailure(
  outcome: SkillPublicationClientResult<PreparationReceipt>,
): "candidate_invalid" | "candidate_stale" | null {
  if (outcome.outcome !== "http_error") return null;
  if (outcome.status === 404 || outcome.status === 422)
    return "candidate_invalid";
  if (outcome.status === 409) return "candidate_stale";
  return null;
}

async function stayPreparing(
  deps: ProcessorDeps,
  op: OperationRow,
  attemptCount: number,
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "preparing", "preparing", {
    ...pauseClearPatch(op),
    attemptCount,
    nextRetryAt: retryAtSeconds(now, backoffSecondsFor(attemptCount)),
    correlationId: deps.correlationId(),
  });
}

async function mapPrepareOutcome(
  deps: ProcessorDeps,
  op: OperationRow,
  outcome: SkillPublicationClientResult<PreparationReceipt>,
  targets: ComparisonTarget[],
  attemptCount: number,
): Promise<AdvanceResult> {
  if (outcome.outcome === "success") {
    return applyDuplicatePolicy(deps, op, outcome.body, targets, attemptCount);
  }
  const terminalCode = isTerminalPrepareFailure(outcome);
  if (terminalCode) {
    return transitionResult(deps.admin, op.id, "preparing", "failed", {
      ...pauseClearPatch(op),
      attemptCount,
      statusCode: terminalCode,
      statusDealStepId: null,
      correlationId: deps.correlationId(),
    });
  }
  return stayPreparing(deps, op, attemptCount);
}

async function pauseState(
  deps: ProcessorDeps,
  op: OperationRow,
  code: "access_lost" | "feature_disabled",
): Promise<AdvanceResult> {
  const now = deps.now();
  return transitionResult(deps.admin, op.id, "preparing", "preparing", {
    statusCode: code,
    nextRetryAt: retryAtSeconds(now, PAUSE_RETRY_SECONDS),
    correlationId: deps.correlationId(),
  });
}

async function failInvalidCandidateName(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  return transitionResult(deps.admin, op.id, "preparing", "failed", {
    ...pauseClearPatch(op),
    statusCode: "candidate_invalid",
    statusDealStepId: null,
    correlationId: deps.correlationId(),
  });
}

async function callPrepare(
  deps: ProcessorDeps,
  op: OperationRow,
  requestOutcome: Extract<PrepareRequestOutcome, { kind: "ok" }>,
  targets: ComparisonTarget[],
): Promise<AdvanceResult> {
  const attemptCount = op.attempt_count + 1;
  const outcome = await deps.ignatious.prepare(op.id, requestOutcome.request, {
    correlationId: deps.correlationId(),
  });
  return mapPrepareOutcome(deps, op, outcome, targets, attemptCount);
}

export async function advancePreparing(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  const auth = await checkAuthorization(deps, op);
  if (!auth.authorized) {
    return pauseState(deps, op, auth.code);
  }

  const comparisonSet = await buildComparisonSetOrPause(deps, op, "preparing");
  if (comparisonSet.kind === "integrity_error") return comparisonSet.result;

  const requestOutcome = await buildPrepareRequest(
    deps.admin,
    op,
    comparisonSet.comparisonSetDigest,
    comparisonSet.targets,
  );
  if (requestOutcome.kind === "invalid_name") {
    return failInvalidCandidateName(deps, op);
  }

  return callPrepare(deps, op, requestOutcome, comparisonSet.targets);
}
