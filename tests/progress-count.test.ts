import { describe, expect, it } from 'vitest';

import { railHeaderProgress } from '@/components/rail/railBoardModel';
import { STEP_STATUS, type StepStatus } from '@/lib/constants/dealSteps';
import { dealRow } from '@/lib/deals/commandCenter';
import { mapApiDeal } from '@/lib/deals/useDeals';
import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';
import { countSteps, countStepsByPhase, GATE0_INTAKE_DONE } from '@/lib/rail/progressCount';
import type { ProjectRailStep } from '@/lib/rail/projectRail';
import { gate0IntakeCompleteStepIds } from '@/lib/rail/stepRecords';

/*
 * The Conductor Center's phase % and GET /api/v1/deals
 * `phaseProgress` count by the rail's rule, so "N of M steps done" on the
 * rail equals the sum the hub shows. The case that drifted is Phase 1, where
 * the rail counts the Gate 0 intake steps (p1-s7, p1-s6, g0-notify) as done
 * for every API deal whatever their stored status.
 */

const API_DEAL = mapApiDeal({
  id: 'uuid-1',
  code: 'ALDER-2026-965',
  codename: 'Project Alder',
  status: 'active',
  createdAt: '2026-09-18T00:00:00Z',
  entryStepSeq: 11,
  currentStepSeq: 14,
  currentStep: { stepId: 'p1-s14', seq: 14, phaseIndex: 1, title: null },
  targetName: null,
  dealRole: 'md',
  conflictsApprovedBy: 'Avery Lindqvist',
  conflictsApprovedOn: '2026-09-18',
});

/** The deal's own rail as the rail route returns it: entered at seq 11, two
 *  steps done, one skipped, the cursor on seq 14, one custom step removed. */
function railSteps(): ProjectRailStep[] {
  const statusFor = (seq: number): StepStatus => {
    if (seq < 11) return STEP_STATUS.SKIPPED_ENTRY;
    if (seq === 11 || seq === 12) return STEP_STATUS.COMPLETE;
    if (seq === 13) return STEP_STATUS.SKIPPED;
    if (seq === 14) return STEP_STATUS.CURRENT;
    return STEP_STATUS.PENDING;
  };
  const steps: ProjectRailStep[] = orderedSteps(MVP_DEAL_RAIL).map((step, i) => ({
    id: `row-${step.id}`,
    stepId: step.id,
    origin: 'catalog',
    phaseIndex: MVP_DEAL_RAIL.find((p) => p.steps.some((s) => s.id === step.id))!.index,
    displayOrder: i,
    seq: step.seq,
    status: statusFor(step.seq),
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  }));
  steps.push({
    ...steps[10],
    id: 'row-custom',
    stepId: 'custom:gone',
    origin: 'custom',
    seq: null,
    status: STEP_STATUS.COMPLETE,
    removedAt: '2026-10-01T00:00:00Z',
  });
  return steps;
}

describe('one counting rule for the rail and the Conductor Center', () => {
  it('the API deal list counts Gate 0 intake steps exactly as the rail does', () => {
    expect(gate0IntakeCompleteStepIds(API_DEAL)).toEqual(new Set(GATE0_INTAKE_DONE));
  });

  it('hub per-phase sums equal the rail "N of M steps done" for a deal with Gate 0 steps', () => {
    const steps = railSteps();
    // The rail header's whole-rail line (no phase summaries → "N of M steps done").
    const rail = railHeaderProgress(
      [],
      steps.filter((s) => s.removedAt === null),
      gate0IntakeCompleteStepIds(API_DEAL),
    ).line;
    const byPhase = countStepsByPhase(steps, GATE0_INTAKE_DONE);
    const done = byPhase.reduce((n, p) => n + p.done, 0);
    const total = byPhase.reduce((n, p) => n + p.total, 0);
    expect(`${done} of ${total} steps done`).toBe(rail);
    expect(countSteps(steps, GATE0_INTAKE_DONE)).toEqual({ done, total });

    // Phase 1 is where a naive count drifts: Gate 0 (3) + seq 11, 12, 13 = 6
    // done, of the 3 Gate 0 steps plus every phase-1 step from the entry on.
    const phase1 = byPhase.find((p) => p.phaseIndex === 1)!;
    const fromEntry = MVP_DEAL_RAIL[0].steps.filter((s) => s.seq >= 11).length;
    expect(phase1).toEqual({ phaseIndex: 1, done: 6, total: 3 + fromEntry });
  });

  it('the Conductor Center row shows the same phase-1 % the rail implies', () => {
    const byPhase = countStepsByPhase(railSteps(), GATE0_INTAKE_DONE);
    const row = dealRow({ ...API_DEAL, phaseProgress: byPhase });
    const phase1 = byPhase.find((p) => p.phaseIndex === 1)!;
    expect(row.phasePercent).toBe(Math.round((phase1.done / phase1.total) * 100));
  });
});
