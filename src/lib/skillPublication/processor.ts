import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { isFlagEnabled } from "@/lib/api/v1/requireFlag";
import { buildComparisonSet } from "./comparisonSet";
import { lookup, prepare, publish } from "./ignatiousClient";
import { logProcessorEvent } from "./processorLog";
import { advanceAttaching } from "./processorAttach";
import { advancePreparing } from "./processorPrepare";
import { advancePublishing } from "./processorPublish";
import { advanceReconciling } from "./processorReconcile";
import { fetchOperation } from "./processorRead";
import { PAUSE_RETRY_SECONDS, retryAtSeconds } from "./processorTiming";
import { transitionResult } from "./processorTransition";
import type { PublicationState } from "./types";
import type {
  AdvanceResult,
  OperationRow,
  ProcessorDeps,
} from "./processorTypes";
import { dbFailure } from '@/lib/errors/upstream';

export type { AdvanceResult } from "./processorTypes";

const DUE_STATES = new Set<PublicationState>([
  "preparing",
  "publishing",
  "attaching",
  "reconciling",
]);

function isStopState(state: PublicationState): boolean {
  return !DUE_STATES.has(state);
}

async function advanceOperation(
  deps: ProcessorDeps,
  op: OperationRow,
): Promise<AdvanceResult> {
  switch (op.state) {
    case "preparing":
      return advancePreparing(deps, op);
    case "publishing":
      return advancePublishing(deps, op);
    case "reconciling":
      return advanceReconciling(deps, op);
    case "attaching":
      return advanceAttaching(deps, op);
    default:
      return { publicationId: op.id, state: op.state, progressed: false };
  }
}

async function advancePublicationWith(
  deps: ProcessorDeps,
  publicationId: string,
): Promise<AdvanceResult> {
  const op = await fetchOperation(deps.admin, publicationId);
  return advanceOperation(deps, op);
}

function isRetryInFuture(op: OperationRow, now: Date): boolean {
  return op.next_retry_at !== null && new Date(op.next_retry_at) > now;
}

async function drivePublicationWith(
  deps: ProcessorDeps,
  publicationId: string,
  maxSteps = 4,
): Promise<AdvanceResult> {
  let last: AdvanceResult | null = null;
  for (let step = 0; step < maxSteps; step++) {
    const op = await fetchOperation(deps.admin, publicationId);
    if (isStopState(op.state) || isRetryInFuture(op, deps.now())) {
      if (last) break;
      last = { publicationId, state: op.state, progressed: false };
      break;
    }
    const result = await advanceOperation(deps, op);
    last = result;
    if (!result.progressed) break;
    if (isStopState(result.state)) break;
    if (result.state === op.state) break;
  }
  return last as AdvanceResult;
}

function assertDueIds(data: unknown): string[] {
  if (!Array.isArray(data) || !data.every((id) => typeof id === "string")) {
    throw new Error("skill_publication_due_invalid_response");
  }
  return data;
}

async function pauseAfterProcessorError(
  deps: ProcessorDeps,
  publicationId: string,
  state: PublicationState,
): Promise<void> {
  try {
    await transitionResult(deps.admin, publicationId, state, state, {
      nextRetryAt: retryAtSeconds(deps.now(), PAUSE_RETRY_SECONDS),
      correlationId: deps.correlationId(),
    });
  } catch {
    logProcessorEvent(
      publicationId,
      state,
      "processor_error",
      deps.correlationId(),
    );
  }
}

async function driveDueRow(
  deps: ProcessorDeps,
  publicationId: string,
): Promise<AdvanceResult> {
  let knownState: PublicationState | null = null;
  try {
    const op = await fetchOperation(deps.admin, publicationId);
    knownState = op.state;
    return await drivePublicationWith(deps, publicationId);
  } catch {
    logProcessorEvent(
      publicationId,
      knownState ?? "unknown",
      "processor_error",
      deps.correlationId(),
    );
    if (knownState)
      await pauseAfterProcessorError(deps, publicationId, knownState);
    return { publicationId, state: knownState ?? "failed", progressed: false };
  }
}

async function processDuePublicationsWith(
  deps: ProcessorDeps,
  limit = 25,
): Promise<AdvanceResult[]> {
  const { data, error } = await deps.admin.rpc("skill_publication_due", {
    p_limit: limit,
  });
  if (error) throw dbFailure("Skill publication due read", error);
  const ids = assertDueIds(data ?? []);
  const results: AdvanceResult[] = [];
  for (const id of ids) {
    results.push(await driveDueRow(deps, id));
  }
  return results;
}

export function createPublicationProcessor(deps: ProcessorDeps) {
  return {
    advancePublication: (publicationId: string) =>
      advancePublicationWith(deps, publicationId),
    drivePublication: (publicationId: string, maxSteps?: number) =>
      drivePublicationWith(deps, publicationId, maxSteps),
    processDuePublications: (limit?: number) =>
      processDuePublicationsWith(deps, limit),
  };
}

function defaultDeps(): ProcessorDeps {
  return {
    admin: createSupabaseAdminClient(),
    ignatious: { prepare, publish, lookup },
    buildComparisonSet,
    isFlagEnabled,
    now: () => new Date(),
    correlationId: () => randomUUID(),
  };
}

export async function advancePublication(
  publicationId: string,
): Promise<AdvanceResult> {
  return createPublicationProcessor(defaultDeps()).advancePublication(
    publicationId,
  );
}

export async function drivePublication(
  publicationId: string,
  maxSteps = 4,
): Promise<AdvanceResult> {
  return createPublicationProcessor(defaultDeps()).drivePublication(
    publicationId,
    maxSteps,
  );
}

export async function processDuePublications(
  limit = 25,
): Promise<AdvanceResult[]> {
  return createPublicationProcessor(defaultDeps()).processDuePublications(
    limit,
  );
}
