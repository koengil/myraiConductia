import { ComparisonSetIntegrityError } from "./comparisonSetIntegrityError";
import { logProcessorEvent } from "./processorLog";
import { pauseClearPatch, transitionResult } from "./processorTransition";
import { backoffSecondsFor, retryAtSeconds } from "./processorTiming";
import type { ComparisonTarget, PublicationState } from "./types";
import type {
  AdvanceResult,
  OperationRow,
  ProcessorDeps,
} from "./processorTypes";

export type ComparisonSetOutcome =
  | { kind: "ok"; targets: ComparisonTarget[]; comparisonSetDigest: string }
  | { kind: "integrity_error"; result: AdvanceResult };

export async function buildComparisonSetOrPause(
  deps: ProcessorDeps,
  op: OperationRow,
  state: PublicationState,
): Promise<ComparisonSetOutcome> {
  try {
    const built = await deps.buildComparisonSet(deps.admin, {
      dealId: op.deal_id,
      operationId: op.id,
    });
    return { kind: "ok", ...built };
  } catch (error) {
    if (!(error instanceof ComparisonSetIntegrityError)) throw error;
    logProcessorEvent(op.id, state, error.reason, deps.correlationId());
    const now = deps.now();
    const result = await transitionResult(deps.admin, op.id, state, state, {
      ...pauseClearPatch(op),
      nextRetryAt: retryAtSeconds(now, backoffSecondsFor(op.attempt_count)),
      correlationId: deps.correlationId(),
    });
    return { kind: "integrity_error", result };
  }
}
