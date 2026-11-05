import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';
import { getAllDeals } from '@/lib/rail/deals';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';

// #200: a completion the step PATCH recorded already advanced the rail inside
// deal_step_save, so the rail must not write /progress for it; the bare
// "Move to the next step" never reaches the step row and still persists the position.
// Both pick the next step the way deal_step_save does.

const [first, second, third] = orderedSteps(MVP_DEAL_RAIL);

function step(id: string, catalog: typeof first, order: number, status: ProjectRailStep['status']): ProjectRailStep {
  return {
    id,
    stepId: catalog.id,
    origin: 'catalog',
    phaseIndex: 1,
    displayOrder: order,
    seq: catalog.seq,
    status,
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog,
  };
}

const state = { rail: null as ProjectRail | null, currentStepId: 'b' };

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => key === 'gate0_api_create',
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'deal-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/deal-1',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/deals/useDeals', () => ({
  useDeals: () => ({ state: { status: 'ready' }, deals: [{ ...getAllDeals()[0], id: 'deal-1' }] }),
  useActiveDeal: () => ({ ...getAllDeals()[0], id: 'deal-1' }),
}));

vi.mock('@/lib/rail/projectRail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rail/projectRail')>()),
  useProjectRail: () => ({
    rail: state.rail,
    status: 'ready',
    refresh: vi.fn(),
    skipStep: vi.fn(),
    stepRecords: [],
  }),
}));

vi.mock('@/components/rail/StepZoom', () => ({
  StepZoom: ({
    steps,
    viewIndex,
    onComplete,
    onJump,
  }: {
    steps: ProjectRailStep[];
    viewIndex: number;
    onComplete: (options?: { recorded?: boolean; stepId?: string; currentStepId?: string | null }) => void;
    onJump: (index: number) => void;
  }) => (
    <div>
      <p data-testid="statuses">{steps.map((s) => `${s.id}:${s.status}`).join(",")}</p>
      <button onClick={() => onJump(2)}>Focus third</button>
      <p data-testid="focused">{steps[viewIndex]?.id}</p>
      <button onClick={() => onComplete({ recorded: true, stepId: steps[viewIndex].id, currentStepId: state.currentStepId })}>Recorded complete</button>
      <button onClick={() => onComplete()}>Move to the next step</button>
    </div>
  ),
}));

function progressCalls() {
  return vi
    .mocked(global.fetch)
    .mock.calls.filter(([input]) => String(input).includes('/progress'));
}

async function renderRail() {
  const { DealRail } = await import('@/components/rail/DealRail');
  render(<DealRail />);
  fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));
}

describe('DealRail completion (#200)', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    state.currentStepId = 'b';
    state.rail = {
      currentStepId: 'a',
      canEditStructure: false,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [step('a', first, 1, 'current'), step('b', second, 2, 'pending'), step('c', third, 3, 'pending')],
    };
  });

  it('does not write /progress for a completion the step PATCH recorded', async () => {
    await renderRail();
    fireEvent.click(screen.getByText('Recorded complete'));
    expect(screen.getByTestId('focused')).toHaveTextContent('b');
    expect(progressCalls()).toHaveLength(0);
  });

  it('completes the focused pending step without moving the current cursor', async () => {
    await renderRail();
    state.currentStepId = 'a';
    fireEvent.click(screen.getByText('Focus third'));
    fireEvent.click(screen.getByText('Recorded complete'));
    expect(screen.getByTestId('statuses')).toHaveTextContent('a:current,b:pending,c:complete');
    expect(screen.getByTestId('focused')).toHaveTextContent('c');
    expect(progressCalls()).toHaveLength(0);
  });

  it('persists the position for the bare advance (Move to the next step), through PATCH /progress only', async () => {
    await renderRail();
    fireEvent.click(screen.getByText('Move to the next step'));
    expect(progressCalls()).toHaveLength(1);
    expect(JSON.parse(String(progressCalls()[0][1]?.body))).toEqual({ currentStepSeq: second.seq });
  });

  it('passes over a step already finished out of order, as deal_step_save does', async () => {
    state.rail!.steps[1] = step('b', second, 2, 'complete');
    await renderRail();
    fireEvent.click(screen.getByText('Move to the next step'));
    expect(screen.getByTestId('focused')).toHaveTextContent('c');
    expect(JSON.parse(String(progressCalls()[0][1]?.body))).toEqual({ currentStepSeq: third.seq });
  });

it('uses the committed cursor even when the local next step is still pending', async () => {
  state.currentStepId = 'c';
  state.rail = {
    currentStepId: 'a', canEditStructure: false, canSaveTemplate: false, phases: [],
    steps: [step('a', first, 1, 'current'), step('b', second, 2, 'pending'), step('c', third, 3, 'pending')],
  };
  await renderRail();
  fireEvent.click(screen.getByText('Recorded complete'));
  expect(screen.getByTestId('focused')).toHaveTextContent('c');
  expect(progressCalls()).toHaveLength(0);
});

});

// A refused or failed /progress write used to pass silently: fetch resolves on a
// 4xx/5xx, and only a network error reached the .catch. The rail now says so.
describe('DealRail progress save failure', () => {
  const failWith = (status: number, error: string) => {
    global.fetch = vi.fn(async () => ({ ok: false, status, json: async () => ({ error }) }) as Response) as unknown as typeof fetch;
  };

  beforeEach(() => {
    state.currentStepId = 'b';
    state.rail = {
      currentStepId: 'a', canEditStructure: false, canSaveTemplate: false, phases: [],
      steps: [step('a', first, 1, 'current'), step('b', second, 2, 'pending'), step('c', third, 3, 'pending')],
    };
  });

  it('says the place was not saved on a 5xx, without the server text', async () => {
    failWith(500, 'relation "deals" does not exist');
    await renderRail();
    fireEvent.click(screen.getByText('Move to the next step'));
    expect(await screen.findByText('Your place on the rail was not saved.')).toBeInTheDocument();
    expect(screen.queryByText(/relation/)).not.toBeInTheDocument();
  });

  it('shows the handler message on a 4xx', async () => {
    failWith(409, 'That step is not on this project rail');
    await renderRail();
    fireEvent.click(screen.getByText('Move to the next step'));
    expect(
      await screen.findByText('Your place on the rail was not saved: That step is not on this project rail.'),
    ).toBeInTheDocument();
  });

  it('Try again resends the same position and clears the notice once it saves', async () => {
    failWith(500, 'boom');
    await renderRail();
    fireEvent.click(screen.getByText('Move to the next step'));
    await screen.findByText('Your place on the rail was not saved.');
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/was not saved/)).not.toBeInTheDocument());
    expect(JSON.parse(String(progressCalls()[0][1]?.body))).toEqual({ currentStepSeq: second.seq });
  });

  it('says you are not on the deal on a 404, with no Try again', async () => {
    failWith(404, 'Deal not found');
    await renderRail();
    fireEvent.click(screen.getByText('Move to the next step'));
    expect(
      await screen.findByText('Your place on the rail was not saved. You are not on this deal.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Deal not found/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
