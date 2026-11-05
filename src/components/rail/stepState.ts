import { STEP_STATUS } from '@/lib/constants/dealSteps';
import { countSteps } from '@/lib/rail/progressCount';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/** Checklist state of a step, including the logged-skip overlay.
 *  `prior` is a step before the deal's entry: it happened before the deal
 *  opened in Conductia, so it is neither done here nor skipped by anyone. */
export type StepState = 'done' | 'active' | 'todo' | 'skipped' | 'prior';

/** A closed step: readable and openable, with no action or run control.
 *  The one gate every action and run control on a step checks. */
export function isReferenceOnly(state: StepState): boolean {
  return state === 'skipped' || state === 'prior';
}

/** Plain status the MD reads. `active` is the deal's position, never a claim
 *  that anyone is working on it. */
export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: 'Done',
  active: 'Current step',
  todo: 'To do',
  skipped: 'Skipped',
  prior: 'Before this deal started',
};

/** Workbench state chips: solid pastel fills, radius 6, sentence case.
 *  The current step stays ink (violet is reserved for an active run). */
export const STEP_STATE_CHIP: Record<StepState, string> = {
  done: 'rounded-[6px] bg-[var(--positive-fill)] px-1.5 py-px text-[length:var(--text-xxs)] font-medium text-[var(--positive-deep)]',
  active:
    'rounded-[6px] bg-[var(--surface-subtle)] px-1.5 py-px text-[length:var(--text-xxs)] font-medium text-[var(--ink)]',
  todo: 'rounded-[6px] px-1.5 py-px text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)]',
  skipped:
    'rounded-[6px] bg-[var(--surface-subtle)] px-1.5 py-px text-[length:var(--text-xxs)] font-medium text-[var(--ink-secondary)]',
  prior:
    'rounded-[6px] bg-[var(--surface-subtle)] px-1.5 py-px text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)]',
};

const STATUS_TO_STEP_STATE: Record<string, StepState> = {
  [STEP_STATUS.PENDING]: 'todo',
  [STEP_STATUS.CURRENT]: 'active',
  [STEP_STATUS.COMPLETE]: 'done',
  [STEP_STATUS.SKIPPED]: 'skipped',
  [STEP_STATUS.SKIPPED_ENTRY]: 'prior',
};

export function stepStateForStep(
  step: ProjectRailStep,
  overlay: { skip?: boolean; done?: boolean } = {},
): StepState {
  if (overlay.skip) return 'skipped';
  if (overlay.done) return 'done';
  return STATUS_TO_STEP_STATE[step.status] ?? 'todo';
}

/** Where the rail rests with no cursor: the last step once every counted
 *  step is done or skipped (the deal is finished), else the first. */
export function restingStepIndex(
  steps: readonly ProjectRailStep[],
  intakeDoneIds?: ReadonlySet<string>,
): number {
  const { done, total } = countSteps(steps, intakeDoneIds);
  return total > 0 && done === total ? steps.length - 1 : 0;
}
