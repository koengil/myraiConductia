import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { OPEN_DRAFT_BUTTON } from './helpers/draftButton';

import { StepContract } from '../src/components/rail/StepContract';
import { MVP_DEAL_RAIL, orderedSteps } from '../src/lib/rail/dealRail';
import type { ProjectRailStep } from '../src/lib/rail/projectRail';

const STEP_ID = 'p1-s10';

const VERSIONS_RESPONSE = {
  current: { kind: 'mount', name: 'meeting-intelligence', version: 1, digest: 'a'.repeat(64) },
  project: [],
  projectUnavailableReason: null,
  catalog: [],
  ancestorContract: null,
};

const RUN_ROW = {
  id: 'run-1',
  outcome: 'succeeded',
  actorName: 'Storm Duncan',
  input: 'Prior meeting notes',
  inputs: {},
  resultText: 'Prior synthesis, filed already.',
  errorMessage: null,
  costUsd: null,
  startedAt: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  binding: { kind: 'mount', name: 'meeting-intelligence', version: 1, digest: 'a'.repeat(64) },
  documents: [],
};

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

const CATALOG_STEP = orderedSteps(MVP_DEAL_RAIL).find((step) => step.id === STEP_ID);
if (!CATALOG_STEP) throw new Error(`${STEP_ID} missing from the MVP rail`);

const PHASE = MVP_DEAL_RAIL.find((p) => p.steps.some((s) => s.id === STEP_ID))!;

const PROJECT_STEP: ProjectRailStep = {
  id: 'deal-step-uuid-1',
  stepId: STEP_ID,
  origin: 'catalog',
  phaseIndex: PHASE.index,
  displayOrder: 1,
  seq: CATALOG_STEP.seq,
  status: 'current',
  definition: null,
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
  catalog: CATALOG_STEP,
};

beforeEach(() => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/skill-versions')) {
      return { ok: true, status: 200, json: async () => VERSIONS_RESPONSE };
    }
    if (url.endsWith('/skill-runs')) {
      return { ok: true, status: 200, json: async () => ({ runs: [RUN_ROW] }) };
    }
    return { ok: true, status: 200, json: async () => ({ step: { work: {} } }) };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a catalog step runner', () => {
  it('resolves its skill and renders a working runner with run history, no BenchStepRunner output', async () => {
    render(
      <StepContract
        step={CATALOG_STEP}
        projectStep={PROJECT_STEP}
        phase={PHASE}
        state="active"
        dealId="villa-2026-503"
        receipts={[]}
        versions={[]}
        onComplete={() => undefined}
        onSkip={() => undefined}
        stepNumber={1}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: OPEN_DRAFT_BUTTON }));

    expect(
      await screen.findByText('Prior synthesis, filed already.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Storm Duncan/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText('Additional instructions')).not.toBeDisabled(),
    );

    expect(screen.queryByText('This step has no skill attached.')).toBeNull();
    expect(screen.queryByText('A draft is not available for this step yet.')).toBeNull();
    expect(screen.queryByLabelText(`${CATALOG_STEP.title} draft`)).toBeNull();
    expect(screen.queryByText(/^Auto ·/)).toBeNull();
  });
});
