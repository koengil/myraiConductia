import type { StepOwnerSummary } from '@/lib/rail/boardContract';
import type { DealStepRecord } from '@/lib/rail/dealStepRecord';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';
import { countSteps } from '@/lib/rail/progressCount';
import { stepStateForStep, type StepState } from './stepState';

/**
 * The rail board's read model: pure functions from the rail, its step records
 * and the deal cursor to what the board, its phase cards and the header show.
 * No React here, so the counts the MD reads are tested on their own.
 */

export type BoardPhase = ProjectRail['phases'][number];

/** Owners keyed by the step's catalog id (`ProjectRailStep.stepId`). Later
 *  chunks add activity to the same summaries; the board only reads them. */
export type StepOwners = ReadonlyMap<string, StepOwnerSummary>;

export type PhasePerson = { id: string; name: string; initials: string };

export type PhaseSummary = {
  phase: BoardPhase;
  /** Short name the progress line uses ("Preparation"). */
  shortName: string;
  steps: ProjectRailStep[];
  done: number;
  total: number;
  /** Whole percent of counted steps done or skipped. */
  pct: number;
  /** Every counted step is done or skipped. */
  complete: boolean;
  /** The deal's current step, when it sits in this phase. */
  currentStep: ProjectRailStep | null;
  /** People assigned to this phase's open steps, in rail order, once each
   *  (by user id). Null when the owners read failed: unknown, not "no one". */
  people: PhasePerson[] | null;
};

/** "Preparation & Market Readiness" reads as "Preparation" where space is short. */
export function shortPhaseName(name: string): string {
  return name.split(/[,&]/)[0].trim() || name;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

/**
 * Owner and activity summaries, keyed by step: owners from the one
 * step-records read the rail already makes, the latest activity from the one
 * audit read. No read per card.
 */
export function ownersFromStepRecords(
  records: readonly DealStepRecord[] | null | undefined,
  activity?: ReadonlyMap<string, NonNullable<StepOwnerSummary['activity']>>,
): Map<string, StepOwnerSummary> {
  const owners = new Map<string, StepOwnerSummary>();
  for (const record of records ?? []) {
    const name = record.assignedToName?.trim();
    if (!name || !record.assignedTo) continue;
    owners.set(record.stepId, {
      stepId: record.stepId,
      owner: { id: record.assignedTo, name, initials: initialsOf(name) },
    });
  }
  for (const [stepId, latest] of activity ?? []) {
    owners.set(stepId, { ...(owners.get(stepId) ?? { stepId }), activity: latest });
  }
  return owners;
}

function isOpen(state: StepState): boolean {
  return state === 'active' || state === 'todo';
}

/** Whole percent of `total` that is `done`; 0 when nothing is counted. */
function percentDone(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

export function phaseSummaries(
  phases: readonly BoardPhase[],
  steps: readonly ProjectRailStep[],
  options: {
    intakeDoneIds?: ReadonlySet<string>;
    currentStepId?: string | null;
    owners?: StepOwners;
    /** The owners read failed: phases say nothing about who is assigned. */
    ownersUnknown?: boolean;
  } = {},
): PhaseSummary[] {
  const { intakeDoneIds, currentStepId, owners, ownersUnknown = false } = options;
  return phases
    .map((phase) => {
      const inPhase = steps.filter((step) => step.phaseIndex === phase.index);
      const { done, total } = countSteps(inPhase, intakeDoneIds);
      const people: PhasePerson[] = [];
      for (const step of inPhase) {
        const state = stepStateForStep(step, { done: intakeDoneIds?.has(step.stepId) });
        const owner = owners?.get(step.stepId)?.owner;
        if (!owner || !isOpen(state) || people.some((p) => p.id === owner.id)) continue;
        people.push({ id: owner.id, name: owner.name, initials: owner.initials || initialsOf(owner.name) });
      }
      return {
        phase,
        shortName: shortPhaseName(phase.name),
        steps: inPhase,
        done,
        total,
        pct: percentDone(done, total),
        complete: total > 0 && done === total,
        currentStep: inPhase.find((step) => step.id === currentStepId) ?? null,
        people: ownersUnknown ? null : people,
      };
    })
    .filter((summary) => summary.steps.length > 0);
}

export type RailHeaderProgress = {
  /** The phase the deal is in, or null once there is no current step. */
  phase: PhaseSummary | null;
  /** "Preparation · 4 of 13 steps done", or the whole rail with no phase. */
  line: string;
  done: number;
  total: number;
  pct: number;
};

/** The one progress line and the overall bar the rail header shows. */
export function railHeaderProgress(
  summaries: readonly PhaseSummary[],
  steps: readonly ProjectRailStep[],
  intakeDoneIds?: ReadonlySet<string>,
): RailHeaderProgress {
  const { done, total } = countSteps(steps, intakeDoneIds);
  const phase = summaries.find((summary) => summary.currentStep !== null) ?? null;
  return {
    phase,
    line: phase
      ? `${phase.shortName} · ${phase.done} of ${phase.total} steps done`
      : `${done} of ${total} steps done`,
    done,
    total,
    pct: percentDone(done, total),
  };
}
