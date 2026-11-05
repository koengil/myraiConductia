import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { StepContract } from '@/components/rail/StepContract';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/*
 * The draft button names a skill only once one resolves. With no skill,
 * the step says "No skill attached yet." and offers no "Draft with the" button;
 * while the read is pending it shows no button at all.
 */

vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: () => ({ state: { status: 'loading' } }) }));

const flags = Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, false])) as FlagMap;
const STEP_ID = 'p1-s10';
const step = orderedSteps(DEAL_RAIL).find((s) => s.id === STEP_ID)!;
const projectStep: ProjectRailStep = {
  id: 'uuid-10',
  stepId: STEP_ID,
  origin: 'catalog',
  phaseIndex: phaseForStep(STEP_ID, DEAL_RAIL)!.index,
  displayOrder: 1,
  seq: step.seq,
  status: 'pending',
  definition: null,
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
  catalog: step,
};

function serve(versions: unknown, runs: unknown[] = [], hold = false, runsStatus = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/skill-versions')) {
        return hold
          ? new Promise<Response>(() => {})
          : Promise.resolve({ ok: true, status: 200, json: async () => versions } as Response);
      }
      if (url.endsWith('/skill-runs')) {
        return Promise.resolve({ ok: runsStatus < 400, status: runsStatus, json: async () => ({ runs }) } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ step: { work: {} } }) } as Response);
    }),
  );
}

function renderStep() {
  render(
    <FlagsProvider value={flags}>
      <StepContract
        step={step}
        projectStep={projectStep}
        phase={phaseForStep(STEP_ID, DEAL_RAIL)!}
        state="todo"
        dealId="deal-1"
        receipts={[]}
        versions={[]}
        onComplete={() => {}}
        onSkip={() => {}}
        stepNumber={4}
      />
    </FlagsProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the draft button and the step skill', () => {
  it('with no skill, says "No skill attached yet." and offers no "Draft with the" button', async () => {
    serve({ current: null, catalog: [] });
    renderStep();
    expect(await screen.findByText('No skill attached yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Draft with the/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open earlier drafts…' })).not.toBeInTheDocument();
    // The step view claims no draft it cannot make (S6-25).
    expect(screen.queryByText(/^Conductia drafts/)).not.toBeInTheDocument();
  });

  it('with no skill but earlier runs, opens them without naming a skill', async () => {
    serve({ current: null, catalog: [] }, [{ id: 'run-1' }]);
    renderStep();
    expect(await screen.findByRole('button', { name: 'Open earlier drafts…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Draft with the/ })).not.toBeInTheDocument();
  });

  it('with no skill and a failed runs read, still offers the earlier drafts (unknown, not none)', async () => {
    serve({ current: null, catalog: [] }, [], false, 500);
    renderStep();
    expect(await screen.findByText('No skill attached yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open earlier drafts…' })).toBeInTheDocument();
  });

  it('with a resolved skill, names it on the button', async () => {
    serve({ current: { kind: 'catalog', skillId: 's', versionId: 'v' }, catalog: [] });
    renderStep();
    expect(await screen.findByRole('button', { name: `Draft with the ${step.title} skill…` })).toBeInTheDocument();
    expect(screen.queryByText('No skill attached yet.')).not.toBeInTheDocument();
  });

  it('shows no button while the read is pending', async () => {
    serve(null, [], true);
    renderStep();
    await screen.findByRole('region', { name: 'Actions' });
    expect(screen.queryByRole('button', { name: /^Draft/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No skill attached yet.')).not.toBeInTheDocument();
  });
});
