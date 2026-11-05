import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { StepContract } from '@/components/rail/StepContract';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { DEAL_RAIL, TEASER_STEP_ID, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/* An Observer's current step shows Move to the next step and Skip disabled, with the seat reason. */

const role = vi.hoisted(() => ({ value: 'read_only' }));
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return {
    ...actual,
    useActiveDeal: () => ({ id: 'deal-1', code: 'deal-1', codename: 'Project Ridge', dealRole: role.value }),
  };
});
vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: () => ({ state: { status: 'loading' } }) }));

const flags = Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, false])) as FlagMap;
const step = orderedSteps(DEAL_RAIL).find((s) => s.id === TEASER_STEP_ID)!;
const projectStep: ProjectRailStep = {
  id: 'uuid-teaser',
  stepId: TEASER_STEP_ID,
  origin: 'catalog',
  phaseIndex: 2,
  displayOrder: 1,
  seq: step.seq,
  status: 'current',
  definition: null,
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
  catalog: step,
};

function renderContract() {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ step: { work: {} } }) })));
  render(
    <FlagsProvider value={flags}>
      <StepContract
        step={step}
        projectStep={projectStep}
        phase={phaseForStep(TEASER_STEP_ID, DEAL_RAIL)!}
        state="active"
        dealId="deal-1"
        receipts={[]}
        versions={[]}
        onComplete={() => {}}
        onSkip={() => {}}
        stepNumber={32}
      />
    </FlagsProvider>,
  );
}

const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  role.value = 'read_only';
});

describe('StepContract for an Observer', () => {
  it('disables Move to the next step and Skip, each pointing at the visible seat reason', async () => {
    renderContract();
    const advance = await screen.findByRole('button', { name: 'Move to the next step' });
    const skip = screen.getByRole('button', { name: 'Skip…' });
    expect(advance).toBeDisabled();
    expect(skip).toBeDisabled();
    expect(describedBy(advance)).toContain("Your seat can't complete or skip this step.");
    expect(describedBy(skip)).toEqual(["Your seat can't complete or skip this step."]);
  });

  it('leaves them live for a deal team seat', async () => {
    role.value = 'deal_team';
    renderContract();
    const advance = await screen.findByRole('button', { name: 'Move to the next step' });
    await waitFor(() => expect(advance).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Skip…' })).toBeEnabled();
    expect(screen.queryByText("Your seat can't complete or skip this step.")).not.toBeInTheDocument();
  });
});

describe('CustomStepPanel for an Observer (handoff E38)', () => {
  const customStep: ProjectRailStep = {
    ...projectStep,
    id: 'uuid-custom',
    stepId: 'custom:abc',
    origin: 'custom',
    seq: null,
    definition: { title: 'Weekly project update', description: 'd' },
    catalog: undefined,
  };

  async function renderCustom() {
    const { CustomStepPanel } = await import('@/components/rail/CustomStepPanel');
    render(
      <FlagsProvider value={flags}>
        <CustomStepPanel step={customStep} state="active" dealId="deal-1" onComplete={() => {}} />
      </FlagsProvider>,
    );
  }

  it('disables Move to the next step with the visible seat reason', async () => {
    await renderCustom();
    const advance = screen.getByRole('button', { name: 'Move to the next step' });
    expect(advance).toBeDisabled();
    expect(describedBy(advance)).toContain("Your seat can't complete or skip this step.");
    expect(describedBy(advance)).toContain("This moves the deal's current step. It does not record this step as done.");
  });

  it('leaves it live for a deal team seat', async () => {
    role.value = 'deal_team';
    await renderCustom();
    expect(screen.getByRole('button', { name: 'Move to the next step' })).toBeEnabled();
    expect(screen.queryByText("Your seat can't complete or skip this step.")).not.toBeInTheDocument();
  });
});
