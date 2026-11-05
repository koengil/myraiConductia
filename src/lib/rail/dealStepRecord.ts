// The platform's per-step record for a deal, as returned by
// GET /api/v1/deals/{dealId}/step-records. One row per deal_steps row: who the
// step is assigned to, who closed it, and the logged skip when it was
// skipped rather than completed. The rail overlays these on its steps so a
// skip approved on another device still shows on the card.

import { STEP_STATUS } from '@/lib/constants/dealSteps';
import type { ProjectRailStep, StepSkipRecord } from '@/lib/rail/projectRail';

export type DealStepSkipRecord = {
  approver: string;
  approverRole: string;
  reason: string;
  at: string;
};

export type DealStepRecord = {
  stepId: string;
  seq: number;
  status: string;
  assignedTo: string | null;
  assignedToName: string | null;
  completedBy: string | null;
  completedByName: string | null;
  completedAt: string | null;
  completionNote: string | null;
  /** Present only when the step was skipped through the logged-skip flow. */
  skip: DealStepSkipRecord | null;
};

/** The record's skip in the shape the rail already renders. */
export function skipFromRecord(record: DealStepRecord): StepSkipRecord | null {
  if (!record.skip) return null;
  return {
    at: record.skip.at,
    by: '',
    approver: record.skip.approver,
    reason: record.skip.reason,
  };
}

/**
 * Overlay the platform's skips on the rail steps. A skip the server
 * holds wins over the browser copy: the record is the compliance truth, the
 * local mirror only bridges the moment before the write lands.
 */
export function withServerSkips<T extends ProjectRailStep>(
  steps: T[],
  records: readonly DealStepRecord[] | null | undefined,
): T[] {
  if (!records || records.length === 0) return steps;
  let changed = false;
  const next = steps.map((step) => {
    const record = records.find((r) => r.stepId === step.stepId);
    const skip = record ? skipFromRecord(record) : null;
    if (!skip) return step;
    changed = true;
    return { ...step, status: STEP_STATUS.SKIPPED, skip };
  });
  return changed ? next : steps;
}

/**
 * A teammate's completion, read from fresher step records than the rail.
 * Only closes apply: a step the records hold as complete reads complete, in
 * any order (out-of-order completion never moves the deal's position). A
 * completion is final, so an older records read can never reopen a step.
 * When the records close the rail's current step, the step they hold as
 * current is the new cursor (deal_step_save moved it); with none, there is no
 * cursor.
 */
export function withRecordedCloses<T extends ProjectRailStep>(
  steps: T[],
  currentStepId: string | null,
  records: readonly DealStepRecord[] | null | undefined,
): { steps: T[]; currentStepId: string | null } {
  if (!records || records.length === 0) return { steps, currentStepId };
  const byStepId = new Map(records.map((r) => [r.stepId, r]));
  let changed = false;
  let cursorClosed = false;
  const next = steps.map((step) => {
    const record = byStepId.get(step.stepId);
    if (record?.status !== STEP_STATUS.COMPLETE) return step;
    if (step.status !== STEP_STATUS.PENDING && step.status !== STEP_STATUS.CURRENT) return step;
    changed = true;
    if (step.id === currentStepId) cursorClosed = true;
    return { ...step, status: STEP_STATUS.COMPLETE };
  });
  if (!changed) return { steps, currentStepId };
  if (!cursorClosed) return { steps: next, currentStepId };
  const recordedCurrent = records.find((r) => r.status === STEP_STATUS.CURRENT);
  const cursor = recordedCurrent
    ? next.find((step) => step.stepId === recordedCurrent.stepId) ?? null
    : null;
  return {
    steps: cursor
      ? next.map((step) =>
          step.id === cursor.id && step.status === STEP_STATUS.PENDING
            ? { ...step, status: STEP_STATUS.CURRENT }
            : step,
        )
      : next,
    currentStepId: cursor?.id ?? null,
  };
}
