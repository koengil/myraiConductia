import { describe, expect, it } from 'vitest';

import {
  describeProcessTag,
  isBenchEffortLevel,
  isBenchModelAlias,
  modelsWithinCeiling,
  processTagForRailStep,
  skillMatchesProcessTag,
} from '@/lib/ignatious/processTag';
import { orderedSteps } from '@/lib/rail/dealRail';

describe('processTagForRailStep', () => {
  it('maps every rail step onto the matching Ignatious phase and seq', () => {
    const steps = orderedSteps();
    expect(steps.length).toBe(65);
    for (const step of steps) {
      const match = /^p([1-5])-s(\d+)$/.exec(step.id);
      expect(match).not.toBeNull();
      expect(processTagForRailStep(step.id)).toEqual({
        stageId: `phase-${match![1]}`,
        applicationId: `seq-${step.seq}`,
      });
    }
  });

  it('maps MD Briefing and Teaser to the tags Ignatious uses', () => {
    expect(processTagForRailStep('p1-s9')).toEqual({
      stageId: 'phase-1',
      applicationId: 'seq-9',
    });
    expect(processTagForRailStep('p2-s36')).toEqual({
      stageId: 'phase-2',
      applicationId: 'seq-36',
    });
  });

  it('rejects ids that are not rail steps', () => {
    expect(processTagForRailStep('always')).toBeNull();
    expect(processTagForRailStep('hz-pipeline-crm')).toBeNull();
  });
});

describe('skillMatchesProcessTag', () => {
  it('matches the exact step and always-on utilities', () => {
    const seq9 = { stageId: 'phase-1', applicationId: 'seq-9' };
    expect(skillMatchesProcessTag(seq9, seq9)).toBe(true);
    expect(skillMatchesProcessTag({ stageId: 'always', applicationId: null }, seq9)).toBe(true);
    expect(
      skillMatchesProcessTag({ stageId: 'phase-1', applicationId: 'seq-8' }, seq9),
    ).toBe(false);
  });
});

describe('bench model aliases', () => {
  it('accepts only the three closed aliases', () => {
    expect(isBenchModelAlias('opus')).toBe(true);
    expect(isBenchModelAlias('sonnet')).toBe(true);
    expect(isBenchModelAlias('haiku')).toBe(true);
    expect(isBenchModelAlias('claude-sonnet-5')).toBe(false);
    expect(describeProcessTag({ stageId: 'phase-1', applicationId: 'seq-9' })).toBe(
      'phase-1 · seq-9',
    );
    expect(isBenchEffortLevel('high')).toBe(true);
    expect(isBenchEffortLevel('max')).toBe(false);
  });

  it('caps the model picker at a skill routing ceiling', () => {
    expect(modelsWithinCeiling(null)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(modelsWithinCeiling('sonnet')).toEqual(['sonnet', 'haiku']);
    expect(modelsWithinCeiling('haiku')).toEqual(['haiku']);
  });
});
