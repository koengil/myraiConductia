import { describe, it, expect } from 'vitest';

import { FLAG_REGISTRY } from '@/lib/flags/keys';
import { resolveFlags } from '@/lib/flags/resolveFlags';
import {
  activeSteps,
  nextOpenStepIndex,
  type ProjectRail,
  type ProjectRailStep,
} from '@/lib/rail/projectRail';
import { pendingChanges } from '@/lib/railTemplates/changeReview';

import { TEMPLATE_CHANGE_SET, decided } from './templateChangeSetFixture';

function step(
  stepId: string,
  phaseIndex: number,
  displayOrder: number,
  overrides: Partial<ProjectRailStep> = {},
): ProjectRailStep {
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'catalog',
    phaseIndex,
    displayOrder,
    seq: displayOrder,
    status: 'pending',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

function rail(steps: ProjectRailStep[]): ProjectRail {
  return { currentStepId: null, canEditStructure: true, canSaveTemplate: false, phases: [], steps };
}

const DEAL = rail([step('p4-s49', 4, 49), step('p4-s50', 4, 50), step('p5-s51', 5, 51)]);

describe('template change review flag', () => {
  it('is registered and fails closed', async () => {
    expect(FLAG_REGISTRY).toHaveProperty('template_change_review');
    const flags = await resolveFlags(async () => []);
    expect(flags.template_change_review).toBe(false);
  });
});

describe('pendingChanges', () => {
  it('lists the changes the server reports as undecided', () => {
    const changeSet = decided(TEMPLATE_CHANGE_SET, {
      'added:custom-fairness': 'accepted',
      'removed:p5-s53': 'discarded',
    });
    expect(pendingChanges(changeSet).map((c) => c.id)).toEqual(['added:custom-sanctions']);
  });

  it('lists nothing once every change is decided', () => {
    const changeSet = decided(TEMPLATE_CHANGE_SET, {
      'added:custom-fairness': 'accepted',
      'added:custom-sanctions': 'discarded',
      'removed:p5-s53': 'accepted',
    });
    expect(pendingChanges(changeSet)).toEqual([]);
  });
});

describe('nextOpenStepIndex', () => {
  it('lands on the next pending or current step', () => {
    const steps = activeSteps(DEAL);
    expect(steps[nextOpenStepIndex(steps, 0)]?.stepId).toBe('p4-s50');
  });

  it('skips a step that is already complete', () => {
    const steps = activeSteps(
      rail([step('p4-s49', 4, 49), step('p4-s50', 4, 50, { status: 'complete' }), step('p5-s51', 5, 51)]),
    );
    expect(steps[nextOpenStepIndex(steps, 0)]?.stepId).toBe('p5-s51');
  });

  it('returns -1 when no open step follows', () => {
    const steps = activeSteps(DEAL);
    expect(nextOpenStepIndex(steps, steps.length - 1)).toBe(-1);
  });
});
