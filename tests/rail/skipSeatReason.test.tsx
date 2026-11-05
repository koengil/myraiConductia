import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { StepContract } from '@/components/rail/StepContract';
import { SEAT_CANNOT_ACT } from '@/components/rail/stepActionCopy';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/*
 * S6R5-03: on a colleague's manual step, a director or CCO cannot complete
 * it, and the server refuses a skip on the same capability (canComplete).
 * Skip… is disabled with the same visible reason Mark step complete gives.
 */

vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return {
    ...actual,
    // A director: not an Observer, so the seat itself is not blocked.
    useActiveDeal: () => ({ id: 'deal-1', code: 'deal-1', codename: 'Project Summit', dealRole: 'ib-director' }),
  };
});
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({ state: { status: 'ready', data: { user: { id: 'u-morgan' } } } }),
}));
vi.mock('@/lib/audit/store', () => ({ logAudit: vi.fn() }));

const STEP_ID = 'p1-s11';
const flags = {
  ...Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, false])),
  gate0_api_create: true,
} as FlagMap;

function projectStep(): ProjectRailStep {
  const catalog = orderedSteps(MVP_DEAL_RAIL).find((s) => s.id === STEP_ID)!;
  return {
    id: `uuid-${STEP_ID}`,
    stepId: STEP_ID,
    origin: 'catalog',
    phaseIndex: phaseForStep(STEP_ID, MVP_DEAL_RAIL)!.index,
    displayOrder: 1,
    seq: catalog.seq,
    status: 'current',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog,
  };
}

function renderStep(canComplete: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        step: {
          stepId: STEP_ID,
          status: 'current',
          assignedTo: 'u-alex',
          assignedToName: 'Alex Chen',
          work: {},
        },
        currentStepId: STEP_ID,
        members: [],
        permissions: { isMd: false, canAssign: false, canComplete, canEditWork: canComplete },
        runs: [],
      }),
    })),
  );
  const ps = projectStep();
  render(
    <FlagsProvider value={flags}>
      <StepContract
        step={ps.catalog!}
        projectStep={ps}
        phase={phaseForStep(STEP_ID, MVP_DEAL_RAIL)!}
        state="active"
        dealId="deal-1"
        receipts={[]}
        versions={[]}
        onComplete={() => {}}
        onSkip={() => {}}
        stepNumber={12}
      />
    </FlagsProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Skip on a step this seat cannot complete', () => {
  it("is disabled and points at Mark step complete's visible reason", async () => {
    renderStep(false);
    const complete = await screen.findByRole('button', { name: 'Mark step complete' });
    expect(complete).toBeDisabled();
    expect(complete).toHaveAccessibleDescription(SEAT_CANNOT_ACT);
    const skip = screen.getByRole('button', { name: 'Skip…' });
    await waitFor(() => expect(skip).toBeDisabled());
    expect(skip).toHaveAccessibleDescription(SEAT_CANNOT_ACT);
    expect(skip.getAttribute('aria-describedby')).toBe(complete.getAttribute('aria-describedby'));
    expect(screen.getAllByText(SEAT_CANNOT_ACT)).toHaveLength(1);
  });

  it('stays enabled, with no reason, for a seat that can complete', async () => {
    renderStep(true);
    expect(await screen.findByRole('button', { name: 'Mark step complete' })).toBeEnabled();
    const skip = screen.getByRole('button', { name: 'Skip…' });
    expect(skip).toBeEnabled();
    expect(skip).not.toHaveAttribute('aria-describedby');
  });
});
