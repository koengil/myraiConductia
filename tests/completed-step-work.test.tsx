import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

import { StepContract } from '../src/components/rail/StepContract';
import { ManualStepPanel } from '../src/components/rail/ManualStepPanel';
import { MVP_DEAL_RAIL, orderedSteps, type RailStep } from '../src/lib/rail/dealRail';
import type { ProjectRailStep } from '../src/lib/rail/projectRail';

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

const QUALIFICATION_STEP_ID = 'p1-s11';

const SAVED_WORK = {
  recommendation: 'Pursue',
  pursue_pass_rationale: 'Founder is ready and the fee pool clears the hurdle.',
  fee_potential: true,
  transaction_likelihood: true,
  banker_credibility: true,
  ability_to_win: true,
  senior_approval: true,
};

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => key === 'gate0_api_create',
}));

vi.mock('@/lib/rail/stepRecords', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rail/stepRecords')>();
  return {
    ...actual,
    useStepCompletionState: () => ({ record: null, loading: false }),
    useStepCompletion: () => null,
  };
});

vi.mock('@/lib/rail/serverStep', () => ({
  useServerStepPresence: () => 'present',
}));

vi.mock('@/lib/rail/dealTeam', () => ({
  useDealTeamRoster: () => ({ intake: [], later: [], isComplete: false }),
}));

vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return {
    ...actual,
    useActiveDeal: () => ({ codename: 'Project Summit' }),
  };
});

vi.mock('@/lib/audit/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit/store')>();
  return { ...actual, logAudit: vi.fn() };
});

const STEP = orderedSteps(MVP_DEAL_RAIL).find((s) => s.id === QUALIFICATION_STEP_ID);
if (!STEP) throw new Error('Deal Qualification missing from the MVP rail');

const PHASE = MVP_DEAL_RAIL.find((p) => p.steps.some((s) => s.id === QUALIFICATION_STEP_ID))!;

function completeStepResponse(canEditWork = true) {
  return {
    ok: true,
    json: async () => ({
      step: {
        stepId: QUALIFICATION_STEP_ID,
        status: 'complete',
        assignedTo: null,
        assignedToName: null,
        work: SAVED_WORK,
      },
      members: [],
      permissions: { isMd: true, canAssign: true, canComplete: false, canEditWork },
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => completeStepResponse() as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a completed manual step', () => {
  it('still shows the work the MD filed in', async () => {
    render(
      <StepContract
        step={STEP}
        projectStep={projectStepFor(STEP)}
        phase={PHASE}
        state="done"
        dealId="round-2026-222"
        receipts={[]}
        versions={[]}
        onComplete={() => undefined}
        onSkip={() => undefined}
        stepNumber={1}
      />,
    );

    expect(await screen.findByLabelText('Manual step work')).toBeInTheDocument();
    expect(
      await screen.findByDisplayValue(SAVED_WORK.pursue_pass_rationale),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Senior banker approval on record')).toBeChecked();
  });

  it('shows the filed work as a record, not an editable form', async () => {
    render(<ManualStepPanel dealId="round-2026-222" stepId={QUALIFICATION_STEP_ID} />);

    const rationale = await screen.findByDisplayValue(SAVED_WORK.pursue_pass_rationale);
    expect(rationale).toBeDisabled();
    expect(screen.getByLabelText('Senior banker approval on record')).toBeDisabled();
    expect(screen.getByText('Complete on the deal record.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark step complete/ })).toBeNull();
  });

  it('reads the same on a step the rail has not yet advanced past', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => completeStepResponse(false) as unknown as Response),
    );

    render(<ManualStepPanel dealId="round-2026-222" stepId={QUALIFICATION_STEP_ID} />);

    await waitFor(() =>
      expect(screen.getByLabelText('Senior banker approval on record')).toBeDisabled(),
    );
    expect(screen.getByDisplayValue(SAVED_WORK.pursue_pass_rationale)).toBeInTheDocument();
  });
});
