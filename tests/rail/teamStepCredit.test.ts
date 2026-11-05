import { describe, expect, it } from 'vitest';

import { SEED_DEALS } from '@/lib/rail/deals';
import { TEAM_STEP_ID, stepCompletedBy, stepCompletionForFixture } from '@/lib/rail/stepRecords';

/* S6-26: the mandate activation step's credits render exactly as before. */

describe('mandate activation credits', () => {
  const deal = SEED_DEALS[0];

  it('the card names no one, even with a completer on the step record', () => {
    const withRecord = {
      ...deal,
      stepRecords: [
        {
          stepId: TEAM_STEP_ID,
          seq: 26,
          status: 'complete',
          assignedTo: null,
          assignedToName: null,
          completedBy: 'u-md',
          completedByName: 'Storm Duncan',
          completedAt: null,
          completionNote: null,
          skip: null,
        },
      ],
    };
    expect(stepCompletedBy(deal, TEAM_STEP_ID)).toBeNull();
    expect(stepCompletedBy(withRecord as typeof deal, TEAM_STEP_ID)).toBeNull();
  });

  it('a logged skip still credits its approver', () => {
    expect(stepCompletedBy(deal, TEAM_STEP_ID, { approver: 'Storm Duncan' })).toBe('Storm Duncan');
  });

  it('has no Gate 0 completion record', () => {
    expect(stepCompletionForFixture(deal.id, TEAM_STEP_ID)).toBeNull();
  });
});
