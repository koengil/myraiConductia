import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { ProjectRailStep } from '@/lib/rail/projectRail';
import {
  CODENAME_STEP_ID,
  NOTIFY_STEP_ID,
  ON_RECORD,
  codenameCompletionForDeal,
  stepCompletedBy,
} from '@/lib/rail/stepRecords';
import type { FixtureDeal } from '@/lib/rail/deals';
import { phaseSummaries } from '@/components/rail/railBoardModel';

/*
 * Gate 0 credits never name whoever is viewing (handoff E32). With no
 * creator on the deal, the codename and notify credits read "On record" for
 * every viewer.
 */

const { userMock } = vi.hoisted(() => ({ userMock: vi.fn() }));
vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: userMock }));

const viewer = (name: string) => ({
  state: {
    status: 'ready' as const,
    data: {
      user: { id: `u-${name}`, email: `${name}@bank.test`, full_name: name, display_name: name },
      company: null,
      mandate: null,
    },
  },
});

const PHASES = MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus }));
const catalog = orderedSteps(MVP_DEAL_RAIL);

function row(stepId: string, order: number, status: ProjectRailStep['status']): ProjectRailStep {
  const step = catalog.find((s) => s.id === stepId)!;
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'catalog',
    phaseIndex: phaseForStep(stepId, MVP_DEAL_RAIL)?.index ?? 1,
    displayOrder: order,
    seq: step.seq,
    status,
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog: step,
  };
}

// An API deal: no createdBy on the client.
const deal = {
  id: 'SUMMIT-2026-003',
  code: 'SUMMIT-2026-003',
  codename: 'Project Summit',
  gate0Complete: true,
  createdAt: '2026-10-23T12:00:00Z',
} as unknown as FixtureDeal;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Gate 0 credits', () => {
  it('stepRecords never invents a creator: On record when the deal names none', () => {
    expect(codenameCompletionForDeal(deal)?.approvedBy).toBe(ON_RECORD);
    expect(stepCompletedBy(deal, CODENAME_STEP_ID)).toBe(ON_RECORD);
    expect(stepCompletedBy(deal, NOTIFY_STEP_ID)).toBe(ON_RECORD);
    // A creator the deal itself carries is credited.
    const own = { ...deal, createdBy: 'Morgan Vale' } as FixtureDeal;
    expect(stepCompletedBy(own, CODENAME_STEP_ID)).toBe('Morgan Vale');
    expect(stepCompletedBy(own, NOTIFY_STEP_ID)).toBe('Morgan Vale');
  });

  it('renders the same card lines for two different viewers, naming neither', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const { RailBoard } = await import('@/components/rail/RailBoard');
    const steps = [row(CODENAME_STEP_ID, 1, 'complete'), row('p1-s6', 2, 'complete'), row(NOTIFY_STEP_ID, 3, 'complete')];
    const summaries = phaseSummaries(PHASES, steps, { currentStepId: null });
    const board = () => (
      <RailBoard
        summaries={summaries}
        steps={steps}
        stateFor={() => 'done'}
        run={{ receipts: {}, versions: {} }}
        deal={deal}
        expanded={new Set([1])}
        onTogglePhase={() => {}}
        onOpenStep={() => {}}
      />
    );
    const stackText = () =>
      within(screen.getByRole('list', { name: 'Origination steps' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent);

    userMock.mockReturnValue(viewer('Avery Lindqvist'));
    render(board());
    const asA = stackText();
    cleanup();
    userMock.mockReturnValue(viewer('Jordan Pike'));
    render(board());
    const asB = stackText();

    expect(asA).toEqual(asB);
    const all = asA.join(' ');
    expect(all).not.toMatch(/Avery Lindqvist|Jordan Pike/);
    expect(all).toContain('On record');
  });

  it('the step 01 "Created by" detail reads On record for any viewer', async () => {
    const { StepContract } = await import('@/components/rail/StepContract');
    const { FlagsProvider } = await import('@/lib/flags/FlagsContext');
    const { FLAG_REGISTRY } = await import('@/lib/flags/keys');
    const flags = {
      ...Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, false])),
      gate0_api_create: true,
    } as never;
    const step = catalog.find((s) => s.id === CODENAME_STEP_ID)!;
    const phase = phaseForStep(CODENAME_STEP_ID, MVP_DEAL_RAIL)!;
    const details: string[] = [];
    for (const name of ['Avery Lindqvist', 'Jordan Pike']) {
      userMock.mockReturnValue(viewer(name));
      global.fetch = vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/v1/deals/API-DEAL-NO-CREATOR'
          ? ({ ok: true, status: 200, json: async () => ({ deal: { codename: 'Project Summit', created_at: '2026-10-23T12:00:00Z' } }) } as Response)
          : ({ ok: false, status: 404, json: async () => ({}) } as Response),
      ) as unknown as typeof fetch;
      render(
        <FlagsProvider value={flags}>
          <StepContract
            step={step}
            projectStep={row(CODENAME_STEP_ID, 1, 'complete')}
            phase={phase}
            state="done"
            // An API deal: its read carries the codename, never who created it.
            dealId="API-DEAL-NO-CREATOR"
            receipts={[]}
            versions={[]}
            onComplete={() => {}}
            onSkip={() => {}}
            stepNumber={1}
          />
        </FlagsProvider>,
      );
      expect(await screen.findByText('Created by')).toBeInTheDocument();
      expect(screen.getByText('On record')).toBeInTheDocument();
      details.push(document.body.textContent ?? '');
      expect(document.body.textContent).not.toContain(name);
      cleanup();
    }
    expect(details[0]).toEqual(details[1]);
  });
});
