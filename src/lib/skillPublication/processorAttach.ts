import { backoffSecondsFor, retryAtSeconds } from "./processorTiming";
import { pauseClearPatch, transitionResult } from "./processorTransition";
import type { PublicationState } from "./types";
import type {
  AdvanceResult,
  OperationRow,
  ProcessorDeps,
} from "./processorTypes";

export async function advanceAttaching(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  const { data, error } = await deps.admin.rpc("skill_publication_attach", {
    p_publication_id: op.id,
  });

  if (error || data === null) {
    const attemptCount = op.attempt_count + 1;
    const now = deps.now();
    return transitionResult(deps.admin, op.id, "attaching", "attaching", {
      ...pauseClearPatch(op),
      attemptCount,
      nextRetryAt: retryAtSeconds(now, backoffSecondsFor(attemptCount)),
      correlationId: deps.correlationId(),
    });
  }

  const view = data as Record<string, unknown>;
  return {
    publicationId: op.id,
    state: view.state as PublicationState,
    progressed: true,
  };
}
