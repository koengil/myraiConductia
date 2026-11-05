/**
 * One counting rule for "N of M steps done", shared by every surface that
 * reports a deal's progress (the rail header, the Conductor Center's
 * "% of phase done", GET /api/v1/deals `phaseProgress`), so they cannot drift.
 *
 * It is the rail's rule, and the only implementation of it (the rail header,
 * the board phases and stepState's resting position all call countSteps):
 *   - removed steps count toward neither side;
 *   - a Gate 0 step satisfied at intake (`intakeDoneIds`) is done and counted,
 *     wherever it sits and whatever its stored status;
 *   - otherwise a step before the deal's entry (`skipped_entry`) counts toward
 *     neither side;
 *   - done = complete or skipped.
 */

import { STEP_STATUS } from '../constants/dealSteps';
import { GATE0_STEP_ID_SET } from './gate0';

export type CountableStep = {
  stepId: string;
  phaseIndex: number | null;
  /**
   * One of the SQL step statuses (STEP_STATUS). Kept `string` because
   * GET /api/v1/deals passes its rows' raw status here (route.ts); narrowing
   * it to StepStatus is a one-line change there.
   */
  status: string;
  removedAt?: string | null;
};

export type StepCounts = { done: number; total: number };
export type PhaseStepCounts = StepCounts & { phaseIndex: number };

/**
 * The Gate 0 steps every deal created through Gate 0 has satisfied at intake.
 * Every deal the platform lists was created through Gate 0 with a code name
 * and a conflicts attestation (gate0IntakeCompleteStepIds answers all three
 * for such a deal), so the deal list counts all three as done.
 */
export const GATE0_INTAKE_DONE: ReadonlySet<string> = GATE0_STEP_ID_SET;

/** 'done' | 'open' for a counted step, null for one that counts toward neither side. */
export function countedState(
  step: CountableStep,
  intakeDoneIds?: ReadonlySet<string>,
): 'done' | 'open' | null {
  if (step.removedAt) return null;
  if (intakeDoneIds?.has(step.stepId)) return 'done';
  if (step.status === STEP_STATUS.SKIPPED_ENTRY) return null;
  return step.status === STEP_STATUS.COMPLETE || step.status === STEP_STATUS.SKIPPED ? 'done' : 'open';
}

/** Done of total across the given steps. */
export function countSteps(steps: readonly CountableStep[], intakeDoneIds?: ReadonlySet<string>): StepCounts {
  let done = 0;
  let total = 0;
  for (const step of steps) {
    const state = countedState(step, intakeDoneIds);
    if (state === null) continue;
    total += 1;
    if (state === 'done') done += 1;
  }
  return { done, total };
}

/**
 * Done of total per phase, phases in order; phases with nothing counted are
 * left out. Steps with no phase (`phaseIndex == null`) are skipped: they count
 * toward no phase.
 */
export function countStepsByPhase(
  steps: readonly CountableStep[],
  intakeDoneIds?: ReadonlySet<string>,
): PhaseStepCounts[] {
  const byPhase = new Map<number, CountableStep[]>();
  for (const step of steps) {
    if (step.phaseIndex == null) continue;
    const list = byPhase.get(step.phaseIndex) ?? [];
    list.push(step);
    byPhase.set(step.phaseIndex, list);
  }
  return [...byPhase.entries()]
    .sort(([a], [b]) => a - b)
    .map(([phaseIndex, list]) => ({ phaseIndex, ...countSteps(list, intakeDoneIds) }))
    .filter((p) => p.total > 0);
}
