import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { StepContract } from '../src/components/rail/StepContract';
import { MVP_DEAL_RAIL, orderedSteps, type RailStep } from '../src/lib/rail/dealRail';
import type { ProjectRailStep } from '../src/lib/rail/projectRail';
import { OPEN_DRAFT_BUTTON } from './helpers/draftButton';

function projectStepFor(step: RailStep): ProjectRailStep {
  return {
    id: `deal-step-${step.id}`,
    stepId: step.id,
    origin: 'catalog',
    phaseIndex: 0,
    displayOrder: 0,
    seq: step.seq,
    status: 'pending',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog: step,
  };
}

vi.mock('@/lib/rail/stepRecords', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rail/stepRecords')>();
  return {
    ...actual,
    useStepCompletionState: () => ({ record: null, loading: true }),
    useStepCompletion: () => null,
  };
});

vi.mock('@/lib/rail/serverStep', () => ({
  useServerStepPresence: () => 'loading',
}));

vi.mock('@/lib/rail/dealTeam', () => ({
  useDealTeamRoster: () => ({ intake: [], later: [], isComplete: false }),
}));

const CODENAME = orderedSteps(MVP_DEAL_RAIL).find((step) => step.title === 'Codename');
if (!CODENAME) throw new Error('Codename step missing from the MVP rail');

afterEach(() => {
  cleanup();
});

describe('StepContract loading', () => {
  it('holds the step body until status resolves', () => {
    render(
      <StepContract
        step={CODENAME}
        projectStep={projectStepFor(CODENAME)}
        phase={MVP_DEAL_RAIL[0]}
        state="done"
        dealId="villa-2026-503"
        receipts={[]}
        versions={[]}
        onComplete={() => undefined}
        onSkip={() => undefined}
        stepNumber={1}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading this step…');
    expect(screen.getByText('Loading')).toBeInTheDocument();
    expect(screen.queryByText('Complete')).toBeNull();
    expect(screen.queryByText(/No outputs yet/)).toBeNull();
    expect(screen.queryByRole('button', { name: OPEN_DRAFT_BUTTON })).toBeNull();
    expect(screen.queryByLabelText('What was done')).toBeNull();
  });
});
