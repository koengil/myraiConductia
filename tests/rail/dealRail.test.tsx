import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { cleanup, render, screen, waitFor, within, fireEvent } from '@testing-library/react';

import { MVP_DEAL_RAIL, orderedSteps, phaseForStep, stepIdForSeq } from '@/lib/rail/dealRail';
import { GATE0_STEP_ID_SET } from '@/lib/rail/gate0';
import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import { catalogFor, type ProjectRail, type ProjectRailStep } from '@/lib/rail/projectRail';
import type { TemplateChangeSet } from '@/lib/railTemplates/changeReview';

import { TEMPLATE_CHANGE_SET, decided } from './templateChangeSetFixture';
import { OPEN_DRAFT_BUTTON } from '../helpers/draftButton';
import { MotionGlobalConfig } from 'framer-motion';

// Overlay exits finish at once, so a test awaits a close without running the
// real 180 ms motion. tests/overlay/dialog.test.tsx keeps the exit on real motion.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

const nonProtectedCatalogStep = orderedSteps(MVP_DEAL_RAIL).find(
  (step) => !PROTECTED_STEP_IDS.has(step.id),
);
if (!nonProtectedCatalogStep) {
  throw new Error('Expected at least one non-protected catalogue step for this fixture');
}
const nonProtectedPhaseIndex =
  phaseForStep(nonProtectedCatalogStep.id, MVP_DEAL_RAIL)?.index ?? 1;

const state = {
  flagOn: false,
  reviewOn: false,
  rail: null as ProjectRail | null,
  search: new URLSearchParams(),
  /** Read ?step= from the live URL, as Next's patched history calls make useSearchParams do. */
  liveSearch: false,
  railAfterDecision: null as ProjectRail | null,
  changeSet: null as TemplateChangeSet | null,
  decisionCalls: [] as { url: string; body: unknown }[],
  reopenCalls: [] as string[],
};

const ME = {
  user: {
    id: 'user-1',
    email: 'storm@example.com',
    full_name: 'Storm Duncan',
    display_name: 'Storm Duncan',
    firm_role: null,
    department: null,
    is_external: false,
    status: 'active',
    company_id: null,
    company_role: null,
    can_invite: false,
  },
  company: null,
  mandate: null,
};

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) =>
    key === 'project_rail_model'
      ? state.flagOn
      : key === 'template_change_review'
        ? state.reviewOn
        : false,
}));

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'deal-1' }),
  useRouter: () => router,
  usePathname: () => '/projects/deal-1',
  useSearchParams: () => (state.liveSearch ? new URLSearchParams(window.location.search) : state.search),
}));

function serverStep(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  const entry = orderedSteps(MVP_DEAL_RAIL)[0];
  return {
    id: 'uuid-1',
    stepId: entry.id,
    origin: 'catalog',
    phaseIndex: 1,
    displayOrder: 1,
    seq: entry.seq,
    status: 'current',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog: entry,
    ...overrides,
  };
}

function templateDealRail(canEditStructure = true): ProjectRail {
  const ids = ['p4-s49', 'p4-s50', 'p5-s51', 'p5-s52', 'p5-s53'];
  return {
    currentStepId: 'uuid-p4-s49',
    canEditStructure,
    canSaveTemplate: false,
    phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
    steps: ids.map((stepId, index) => {
      const entry = catalogFor(stepId);
      if (!entry) throw new Error(`missing catalogue step ${stepId}`);
      return serverStep({
        id: `uuid-${stepId}`,
        stepId,
        phaseIndex: phaseForStep(stepId, MVP_DEAL_RAIL)?.index ?? 0,
        displayOrder: entry.seq,
        seq: entry.seq,
        status: index === 0 ? 'current' : 'pending',
        catalog: entry,
      });
    }),
  };
}

function withFairnessOpinion(rail: ProjectRail): ProjectRail {
  const anchor = rail.steps.find((step) => step.stepId === 'p4-s50');
  return {
    ...rail,
    steps: [
      ...rail.steps,
      serverStep({
        id: 'uuid-fairness',
        stepId: 'custom:uuid-fairness',
        origin: 'custom',
        phaseIndex: anchor?.phaseIndex ?? 4,
        displayOrder: (anchor?.displayOrder ?? 0) + 0.5,
        seq: null,
        status: 'pending',
        definition: { title: 'Fairness opinion', description: 'Independent fairness opinion.' },
        catalog: undefined,
      }),
    ],
  };
}

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function renderRail() {
  const { DealRail } = await import('@/components/rail/DealRail');
  render(<DealRail />);
  await waitFor(() =>
    expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
  );
}

/** Open every closed phase and "N done" row on the board so all step cards render. */
function openAllPhases() {
  const board = screen.getByRole('region', { name: 'Rail overview' });
  for (const toggle of within(board).queryAllByRole('button', { expanded: false })) {
    fireEvent.click(toggle);
  }
}

/** The whole-rail count the header bar carries. */
function expectWholeRail(label: string) {
  // The header stays on the page, out of reach behind an open step.
  expect(screen.getByRole('progressbar', { name: 'Rail progress', hidden: true })).toHaveAttribute(
    'aria-valuetext',
    `${label} on the whole rail`,
  );
}

/**
 * Progress as the rail reads it, from the rendered step states: every
 * step but one before the entry counts, and Done and Skipped steps are
 * complete. One rule, applied alike to the flag-on and flag-off rails.
 */
function progressFromRenderedStates(): string {
  const counted = Array.from(document.querySelectorAll('[data-step]'))
    .map((el) => el.getAttribute('data-state'))
    .filter((stationState) => stationState !== 'prior');
  const done = counted.filter((s) => s === 'done' || s === 'skipped').length;
  return `${done} of ${counted.length} steps done`;
}

/**
 * The flag-on rail the server seeds for a deal entered at `entrySeq` with its
 * cursor at `cursorSeq`: every catalogue step, `skipped_entry` before the
 * entry (Gate 0 included), complete up to the cursor, pending after it.
 */
function serverRailEnteredAt(entrySeq: number, cursorSeq: number): ProjectRail {
  const catalog = orderedSteps(MVP_DEAL_RAIL);
  const cursorIndex = catalog.findIndex((step) => step.seq === cursorSeq);
  return {
    currentStepId: `uuid-${cursorIndex + 1}`,
    canEditStructure: false,
    canSaveTemplate: false,
    phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
    steps: catalog.map((step, index) =>
      serverStep({
        id: `uuid-${index + 1}`,
        stepId: step.id,
        phaseIndex: phaseForStep(step.id, MVP_DEAL_RAIL)?.index ?? 1,
        displayOrder: index + 1,
        seq: step.seq,
        status:
          step.seq < entrySeq
            ? 'skipped_entry'
            : index < cursorIndex
              ? 'complete'
              : index === cursorIndex
                ? 'current'
                : 'pending',
        catalog: step,
      }),
    ),
  };
}

function storeFixtureDeal(overrides: Record<string, unknown>) {
  window.localStorage.setItem(
    'ib-fixture-deals',
    JSON.stringify([
      {
        id: 'deal-1',
        codename: 'Project Cedar',
        code: 'CED-2026-001',
        target: 'Cedar Labs',
        sector: 'Software',
        status: 'Origination',
        cursorStepId: stepIdForSeq(20, MVP_DEAL_RAIL),
        entryStepSeq: 12,
        gate0Complete: true,
        dealRole: 'Managing Director',
        ...overrides,
      },
    ]),
  );
}

function stepById(stepId: string): HTMLElement {
  const station = document.querySelector<HTMLElement>(`[data-step="${stepId}"]`);
  if (!station) throw new Error(`Expected a station for ${stepId}`);
  return station;
}

function expectNoActionOrRunControls(container: HTMLElement) {
  expect(within(container).queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument();
  expect(within(container).queryByRole('button', { name: 'Move to the next step' })).not.toBeInTheDocument();
  expect(within(container).queryByRole('button', { name: OPEN_DRAFT_BUTTON })).not.toBeInTheDocument();
  expect(within(container).queryByRole('button', { name: /^Skip/ })).not.toBeInTheDocument();
  expect(within(container).queryByRole('button', { name: 'Close runner' })).not.toBeInTheDocument();
}

const GATE0_ON_RAIL = orderedSteps(MVP_DEAL_RAIL).filter((step) => GATE0_STEP_ID_SET.has(step.id));

describe('DealRail', () => {
  beforeEach(() => {
    state.flagOn = false;
    state.reviewOn = false;
    state.rail = null;
    state.search = new URLSearchParams();
    state.liveSearch = false;
    state.railAfterDecision = null;
    state.changeSet = TEMPLATE_CHANGE_SET;
    state.decisionCalls = [];
    state.reopenCalls = [];
    vi.resetModules();
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/rail/template-changes')) {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { decision: 'accepted' | 'discarded' };
          const changeId = decodeURIComponent(url.split('/template-changes/')[1].split('/')[0]);
          state.decisionCalls.push({ url, body });
          if (state.railAfterDecision) state.rail = state.railAfterDecision;
          state.changeSet = state.changeSet && decided(state.changeSet, { [changeId]: body.decision });
        }
        if (init?.method === 'DELETE') state.reopenCalls.push(url);
        return json({ changeSet: state.changeSet });
      }
      if (url.includes('/rail')) return json(state.rail);
      if (url.includes('/api/v1/me')) return json(ME);
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;
  });

  it('shows no template review and never asks the server with the flag off', async () => {
    state.flagOn = true;
    state.rail = templateDealRail();
    await renderRail();
    expect(screen.queryByRole('status', { name: 'Template updated' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review changes' })).not.toBeInTheDocument();
    expect(
      vi.mocked(global.fetch).mock.calls.some(([input]) => String(input).includes('template-changes')),
    ).toBe(false);
  });

  it('states the pending count the server reports', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    await renderRail();
    expect(await screen.findByRole('status', { name: 'Template updated' })).toHaveTextContent(
      '3 changes wait for your decision.',
    );
  });

  it('records an accepted change on the server and shows the refreshed rail on close', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    state.railAfterDecision = withFairnessOpinion(templateDealRail());
    await renderRail();

    fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Fairness opinion' }));
    await waitFor(() => expect(within(dialog).getByText('Added')).toBeInTheDocument());
    expect(state.decisionCalls).toEqual([
      {
        url: '/api/v1/deals/deal-1/rail/template-changes/added%3Acustom-fairness/decision',
        body: { decision: 'accepted', revisionId: 'revision-4' },
      },
    ]);
    expect(within(dialog).queryByRole('button', { name: 'Undo Fairness opinion' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('button', { name: /· Fairness opinion ·/ })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Template updated' })).toHaveTextContent(
      '2 changes wait for your decision.',
    );
  });

  it('refreshes the rail when a decision lands after the dialog was closed', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    state.railAfterDecision = withFairnessOpinion(templateDealRail());
    const base = global.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') await gate;
      return base(input, init);
    }) as unknown as typeof fetch;
    await renderRail();

    fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Fairness opinion' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    release();

    expect(await screen.findByRole('button', { name: /· Fairness opinion ·/ })).toBeInTheDocument();
  });

  it('refreshes the rail and drops the dialog when a stale decision reloads to no change set', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    state.railAfterDecision = withFairnessOpinion(templateDealRail());
    const base = global.fetch;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        state.rail = state.railAfterDecision;
        state.changeSet = null;
        return { ok: false, status: 409, json: async () => ({ error: 'stale' }) } as Response;
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    await renderRail();

    fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add Fairness opinion' }),
    );

    expect(await screen.findByRole('button', { name: /· Fairness opinion ·/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a way back to a discarded change once nothing is pending', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    state.changeSet = decided(TEMPLATE_CHANGE_SET, {
      'added:custom-fairness': 'accepted',
      'added:custom-sanctions': 'discarded',
      'removed:p5-s53': 'accepted',
    });
    await renderRail();

    expect(await screen.findByRole('status', { name: 'Template decisions' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Template updated' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review decisions' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Undo Sanctions re-screen before signing' }),
    );

    await waitFor(() =>
      expect(state.reopenCalls).toEqual([
        '/api/v1/deals/deal-1/rail/template-changes/added%3Acustom-sanctions/decision',
      ]),
    );
  });

  it('opens the review on arrival from the notice link', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.search = new URLSearchParams('review=template');
    state.rail = templateDealRail();
    await renderRail();
    expect(
      await screen.findByRole('dialog', { name: 'Standard sell-side · v3 → v4' }),
    ).toBeInTheDocument();
  });

  it('lets a read-only member see but not decide template changes', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail(false);
    await renderRail();
    fireEvent.click(await screen.findByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Only the deal team can change this rail.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add Fairness opinion' })).toBeDisabled();
  });

  it('renders every catalogue step in order with the flag off', async () => {
    await renderRail();
    openAllPhases();
    const cards = screen
      .getAllByRole('button', { name: /^Step \d+ · / })
      .map((card) => card.getAttribute('aria-label'));
    expect(cards).toHaveLength(orderedSteps(MVP_DEAL_RAIL).length);
    orderedSteps(MVP_DEAL_RAIL).forEach((step, index) => {
      expect(cards[index]).toContain(`· ${step.title} ·`);
    });
  });

  it('renders a custom step from its definition when the flag is on', async () => {
    state.flagOn = true;
    state.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep(),
        serverStep({
          id: 'uuid-2',
          stepId: 'custom:abc',
          origin: 'custom',
          displayOrder: 2,
          seq: null,
          status: 'pending',
          definition: { title: 'Weekly project update', description: 'Notes to update.' },
          catalog: undefined,
        }),
      ],
    };
    await renderRail();
    expect(screen.getByText('Weekly project update')).toBeInTheDocument();
  });

  it('states that the rail could not be loaded when the rail read fails', async () => {
    state.flagOn = true;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/v1/me')) {
        return { ok: true, json: async () => ME } as Response;
      }
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response;
    }) as unknown as typeof fetch;

    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);

    expect(await screen.findByText('The deal rail could not be loaded right now.')).toBeInTheDocument();
    expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument();
  });

  it('tells an outside party the rail is for the deal team on a 403, with no Try again', async () => {
    state.flagOn = true;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) {
        return { ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) } as Response;
      }
      if (url.includes('/api/v1/me')) return { ok: true, json: async () => ME } as Response;
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;

    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    expect(await screen.findByText("The deal rail is for the bank's deal team.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('The deal rail could not be loaded right now.')).not.toBeInTheDocument();
  });

  it('tells a signed-in user who is not on the deal so on a 404, with a link home and no Try again', async () => {
    state.flagOn = true;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) {
        return { ok: false, status: 404, json: async () => ({ error: 'Deal not found' }) } as Response;
      }
      if (url.includes('/api/v1/me')) return { ok: true, json: async () => ME } as Response;
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;

    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    expect(await screen.findByText('You are not on this deal.')).toBeInTheDocument();
    // The page's one h1 (S6R5-06): the deal-less page title.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Rails' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Conductor Center' })).toHaveAttribute('href', '/projects');
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('The deal rail could not be loaded right now.')).not.toBeInTheDocument();
  });

  it('keeps Try again on a 500', async () => {
    state.flagOn = true;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) } as Response;
      }
      if (url.includes('/api/v1/me')) return { ok: true, json: async () => ME } as Response;
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;

    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    expect(await screen.findByText('The deal rail could not be loaded right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText("The deal rail is for the bank's deal team.")).not.toBeInTheDocument();
  });

  it('offers Try again on a /rail failure, and the retry reaches the ready rail (#162)', async () => {
    state.flagOn = true;
    state.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: false,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [serverStep()],
    };
    let railFails = true;
    let railCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) {
        railCalls += 1;
        return railFails
          ? ({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) } as Response)
          : ({ ok: true, json: async () => state.rail } as Response);
      }
      if (url.includes('/api/v1/me')) {
        return { ok: true, json: async () => ME } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;

    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    expect(await screen.findByText('The deal rail could not be loaded right now.')).toBeInTheDocument();
    expect(railCalls).toBe(1);

    railFails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // The error and its button leave in the same render as the click.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByText('Loading the deal rail…')).toBeInTheDocument();

    expect(await screen.findByLabelText('Rail overview')).toBeInTheDocument();
    expect(screen.queryByText('The deal rail could not be loaded right now.')).not.toBeInTheDocument();
    expect(railCalls).toBe(2);
  });

  it('excludes a removed step from the rail', async () => {
    state.flagOn = true;
    const second = orderedSteps(MVP_DEAL_RAIL)[1];
    state.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep(),
        serverStep({
          id: 'uuid-2',
          stepId: second.id,
          displayOrder: 2,
          seq: second.seq,
          status: 'pending',
          removedAt: '2026-09-09T10:00:00Z',
          catalog: second,
        }),
      ],
    };
    await renderRail();
    expect(screen.getByTestId('step-uuid-1')).toHaveTextContent(orderedSteps(MVP_DEAL_RAIL)[0].title);
    expect(screen.queryByTestId('step-uuid-2')).not.toBeInTheDocument();
    const removedSection = screen.getByText('Removed steps').closest('details');
    if (!removedSection) throw new Error('Expected a Removed steps <details> section');
    expect(within(removedSection).getByText(second.title)).toBeInTheDocument();
  });

  it('says a ?step= naming a removed step is no longer on this rail', async () => {
    state.flagOn = true;
    const second = orderedSteps(MVP_DEAL_RAIL)[1];
    state.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep(),
        serverStep({
          id: 'uuid-2',
          stepId: second.id,
          displayOrder: 2,
          seq: second.seq,
          status: 'pending',
          removedAt: '2026-09-09T10:00:00Z',
          catalog: second,
        }),
      ],
    };
    state.search = new URLSearchParams(`step=${second.seq}`);
    await renderRail();
    expect(await screen.findByText('That step is no longer on this rail.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
    // A ?step= naming no step is still dropped from the address bar.
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/projects/deal-1', { scroll: false }));
  });

  it('reaches Remove in step detail through DealRail -> StepZoom when canEditStructure is true', async () => {
    state.flagOn = true;
    state.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep({
          id: 'uuid-1',
          stepId: nonProtectedCatalogStep.id,
          phaseIndex: nonProtectedPhaseIndex,
          seq: nonProtectedCatalogStep.seq,
          status: 'current',
          catalog: nonProtectedCatalogStep,
        }),
      ],
    };
    await renderRail();
    const station = screen.getByTestId('step-uuid-1');
    // Remove lives in step detail, never on the card, and confirms before it acts.
    expect(within(station).queryByRole('button', { name: /^remove$/i })).not.toBeInTheDocument();
    fireEvent.click(within(station).getByRole('button', { name: /^Step / }));
    const detail = await screen.findByRole('region', { name: 'Step detail' });
    fireEvent.click(within(detail).getByRole('button', { name: /^remove$/i }));
    expect(within(detail).getByRole('button', { name: 'Remove step' })).toBeEnabled();
  });

  it('has no reachable Remove control through DealRail -> RailBoard -> StepCard when canEditStructure is false', async () => {
    state.flagOn = true;
    state.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: false,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep({
          id: 'uuid-1',
          stepId: nonProtectedCatalogStep.id,
          phaseIndex: nonProtectedPhaseIndex,
          seq: nonProtectedCatalogStep.seq,
          status: 'current',
          catalog: nonProtectedCatalogStep,
        }),
      ],
    };
    await renderRail();
    const station = screen.getByTestId('step-uuid-1');
    expect(within(station).queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('opens the step in a dialog over the board on a card click, with Remove reachable there', async () => {
    state.flagOn = true;
    state.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep({
          id: 'uuid-1',
          stepId: nonProtectedCatalogStep.id,
          phaseIndex: nonProtectedPhaseIndex,
          seq: nonProtectedCatalogStep.seq,
          status: 'current',
          catalog: nonProtectedCatalogStep,
        }),
      ],
    };
    await renderRail();
    const station = screen.getByTestId('step-uuid-1');
    fireEvent.click(
      within(station).getByRole('button', { name: new RegExp(`^Step .*${nonProtectedCatalogStep.title}`) }),
    );

    const dialog = screen.getByRole('dialog', { name: 'Rail step' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const focus = within(dialog).getByRole('region', { name: 'Step detail' });
    expect(within(focus).getByRole('button', { name: /remove/i })).toBeEnabled();
    // The board stays mounted behind the dialog, out of reach until it closes.
    expect(station.closest('[inert]')).not.toBeNull();
  });

  it('renders no active step when there is no current step', async () => {
    state.flagOn = true;
    state.rail = {
      currentStepId: null,
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [serverStep({ status: 'complete' })],
    };
    await renderRail();
    expect(screen.queryByTestId('step-active')).not.toBeInTheDocument();
    expect(screen.getByText(orderedSteps(MVP_DEAL_RAIL)[0].title)).toBeInTheDocument();
  });

  it('derives status from the step record, not from position against a cursor', async () => {
    state.flagOn = true;
    const [, second] = orderedSteps(MVP_DEAL_RAIL);
    state.rail = {
      currentStepId: 'uuid-2',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep({ status: 'pending' }),
        serverStep({
          id: 'uuid-2',
          stepId: second.id,
          displayOrder: 2,
          seq: second.seq,
          status: 'current',
          catalog: second,
        }),
      ],
    };
    await renderRail();
    expect(screen.getByTestId('step-uuid-1')).toHaveAttribute('data-status', 'pending');
    expect(screen.getByTestId('step-uuid-2')).toHaveAttribute('data-status', 'current');
  });

  it('numbers steps by their position on the active rail after a removal', async () => {
    state.flagOn = true;
    const [, second, third] = orderedSteps(MVP_DEAL_RAIL);
    state.rail = {
      currentStepId: 'uuid-2',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        serverStep({ status: 'pending', removedAt: '2026-09-10T10:00:00Z' }),
        serverStep({
          id: 'uuid-2',
          stepId: second.id,
          phaseIndex: phaseForStep(second.id, MVP_DEAL_RAIL)?.index ?? 1,
          displayOrder: 2,
          seq: second.seq,
          status: 'current',
          catalog: second,
        }),
        serverStep({
          id: 'uuid-3',
          stepId: third.id,
          phaseIndex: phaseForStep(third.id, MVP_DEAL_RAIL)?.index ?? 1,
          displayOrder: 3,
          seq: third.seq,
          status: 'pending',
          catalog: third,
        }),
      ],
    };
    await renderRail();

    const secondStep = screen.getByTestId('step-uuid-2');
    expect(
      within(secondStep).getByRole('button', {
        name: new RegExp(`^Step 01 · ${second.title}`),
      }),
    ).toBeInTheDocument();
    expect(within(secondStep).getByText('1')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('step-uuid-3')).getByRole('button', {
        name: new RegExp(`^Step 02 · ${third.title}`),
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(secondStep).getByRole('button', { name: new RegExp(second.title) }),
    );
    const focus = screen.getByRole('region', { name: 'Step detail' });
    expect(within(focus).getByRole('button', { name: 'Zoom out to Origination' })).toBeInTheDocument();
    // One count on screen: the zoom names the phase, never "Step N of M".
    expect(within(focus).queryByText(/^Step \d+ of \d+/)).not.toBeInTheDocument();
    expect(
      within(focus).getByRole('button', { name: `Next step · ${third.title}` }),
    ).toBeInTheDocument();
    expect(
      within(focus).getByRole('heading', { level: 2, name: second.title }),
    ).toBeInTheDocument();
    expect(
      within(focus).getByText((_, el) => el?.tagName === 'P' && el.textContent === 'Step 01 · Origination'),
    ).toBeInTheDocument();
  });

  it('states that the rail is not set up when the server rail carries no structure', async () => {
    state.flagOn = true;
    const [first] = orderedSteps(MVP_DEAL_RAIL);
    const unstructuredRail = {
      currentStepId: null,
      canEditStructure: false,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        {
          id: 'uuid-1',
          stepId: first.id,
          origin: 'catalog',
          phaseIndex: null,
          displayOrder: null,
          seq: first.seq,
          status: 'current',
          definition: null,
          anchorStepId: null,
          removedAt: null,
          removedBy: null,
          skip: null,
        },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) {
        return { ok: true, json: async () => unstructuredRail } as Response;
      }
      if (url.includes('/api/v1/me')) {
        return { ok: true, json: async () => ME } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;

    await renderRail();

    expect(
      screen.getByText("This deal's rail is not set up yet. Its steps appear here once setup is complete."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Rail overview' })).not.toBeInTheDocument();
  });

  describe('stations before the entry', () => {
    afterEach(() => {
      window.localStorage.removeItem('ib-fixture-deals');
    });

    it('renders skipped_entry rows as "Before this deal started" and counts progress from the entry (flag on)', async () => {
      state.flagOn = true;
      const [pre1, pre2, pre3, entry, next] = orderedSteps(MVP_DEAL_RAIL).filter(
        (step) => !GATE0_STEP_ID_SET.has(step.id),
      );
      const rows = [pre1, pre2, pre3, entry, next].map((step, index) =>
        serverStep({
          id: `uuid-${index + 1}`,
          stepId: step.id,
          phaseIndex: phaseForStep(step.id, MVP_DEAL_RAIL)?.index ?? 1,
          displayOrder: index + 1,
          seq: step.seq,
          status: index < 3 ? 'skipped_entry' : index === 3 ? 'current' : 'pending',
          catalog: step,
        }),
      );
      state.rail = {
        currentStepId: 'uuid-4',
        canEditStructure: false,
        canSaveTemplate: false,
        phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
        steps: rows,
      };
      await renderRail();

      // Folded into one row until asked for.
      expect(screen.queryByTestId('step-uuid-1')).not.toBeInTheDocument();
      const priorFold = screen.getByRole('button', { name: '3 before Conductia' });
      expect(priorFold).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(priorFold);
      expect(priorFold).toHaveAttribute('aria-expanded', 'true');

      for (const id of ['uuid-1', 'uuid-2', 'uuid-3']) {
        const station = screen.getByTestId(`step-${id}`);
        expect(station).toHaveAttribute('data-state', 'prior');
        expect(
          within(station).getByRole('button', { name: /· Before this deal started$/ }),
        ).toBeInTheDocument();
      }
      expect(screen.getByTestId('step-uuid-4')).toHaveAttribute('data-state', 'active');
      expectWholeRail('0 of 2 steps done');
      expect(progressFromRenderedStates()).toBe('0 of 2 steps done');
      expect(screen.getByRole('progressbar', { name: 'Rail progress' })).toHaveAttribute(
        'aria-valuemax',
        '2',
      );
    });

    it('derives the same states from the flag-off rail with entryStepSeq 12', async () => {
      window.localStorage.setItem(
        'ib-fixture-deals',
        JSON.stringify([
          {
            id: 'deal-1',
            codename: 'Project Cedar',
            code: 'CED-2026-001',
            target: 'Cedar Labs',
            sector: 'Software',
            status: 'Origination',
            cursorStepId: stepIdForSeq(20, MVP_DEAL_RAIL),
            entryStepSeq: 12,
            gate0Complete: true,
            dealRole: 'Managing Director',
          },
        ]),
      );
      await renderRail();
      openAllPhases();

      const catalog = orderedSteps(MVP_DEAL_RAIL);
      for (const step of catalog) {
        const station = screen.getByTestId(`step-${step.id}`);
        if (GATE0_STEP_ID_SET.has(step.id)) {
          // A Gate 0-complete deal: intake satisfied every Gate 0 step.
          expect({ stepId: step.id, state: station.getAttribute('data-state') }).toEqual({
            stepId: step.id,
            state: 'done',
          });
          continue;
        }
        const expected =
          step.seq < 12 ? 'prior' : step.seq < 20 ? 'done' : step.seq === 20 ? 'active' : 'todo';
        expect({ stepId: step.id, state: station.getAttribute('data-state') }).toEqual({
          stepId: step.id,
          state: expected,
        });
      }
      // Same rule as the flag-on rail: steps before the entry count toward
      // neither side; intake-done Gate 0 steps read Done and count in both.
      const fromEntry = catalog.filter((step) => step.seq >= 12).length;
      const label = `${8 + GATE0_ON_RAIL.length} of ${fromEntry + GATE0_ON_RAIL.length} steps done`;
      expect(progressFromRenderedStates()).toBe(label);
      expectWholeRail(label);
      expect(screen.getByRole('progressbar', { name: 'Rail progress' })).toHaveAttribute(
        'aria-valuemax',
        String(fromEntry + GATE0_ON_RAIL.length),
      );
    });

    it('reads pre-entry Gate 0 steps as reference only: intake-done ones Done, the rest Before entry (flag on)', async () => {
      state.flagOn = true;
      // Intake recorded the conflicts attestation only; code name and notify did not run.
      storeFixtureDeal({
        gate0Complete: false,
        conflictsAttestation: { approvedBy: 'Pat Rivera', approvedOn: '2026-09-01' },
      });
      state.rail = serverRailEnteredAt(12, 20);
      await renderRail();
      openAllPhases();

      const conflicts = stepById('p1-s6');
      expect(conflicts).toHaveAttribute('data-status', 'skipped_entry');
      expect(conflicts).toHaveAttribute('data-state', 'done');
      expect(within(conflicts).getByRole('button', { name: /· Done$/ })).toBeInTheDocument();
      expectNoActionOrRunControls(conflicts);
      for (const stepId of ['p1-s7', 'g0-notify']) {
        const station = stepById(stepId);
        expect(station).toHaveAttribute('data-state', 'prior');
        expect(
          within(station).getByRole('button', { name: /· Before this deal started$/ }),
        ).toBeInTheDocument();
        expectNoActionOrRunControls(station);
      }

      // The intake-done step counts on both sides; the other two on neither.
      const fromEntry = orderedSteps(MVP_DEAL_RAIL).filter((step) => step.seq >= 12).length;
      const label = `${8 + 1} of ${fromEntry + 1} steps done`;
      expect(progressFromRenderedStates()).toBe(label);
      expectWholeRail(label);

      // Focus: neither the intake-done nor the pre-entry Gate 0 step can be worked.
      fireEvent.click(within(conflicts).getByRole('button', { name: /^Step / }));
      const focus = screen.getByRole('region', { name: 'Step detail' });
      await waitFor(() =>
        expect(within(focus).queryByText('Loading this step…')).not.toBeInTheDocument(),
      );
      expect(within(focus).getByText('Complete')).toBeInTheDocument();
      expectNoActionOrRunControls(focus);
      expectWholeRail(label);

      const codename = orderedSteps(MVP_DEAL_RAIL).find((step) => step.id === 'p1-s7');
      fireEvent.click(
        within(focus).getByRole('button', { name: `Previous step · ${codename?.title}` }),
      );
      await waitFor(() =>
        expect(
          within(focus).getByText('Happened before this deal opened in Conductia. Reference only.'),
        ).toBeInTheDocument(),
      );
      expectNoActionOrRunControls(focus);
    });

    it('gives the same progress on both producers for the same deal entered partway', async () => {
      storeFixtureDeal({});
      await renderRail();
      openAllPhases();
      const flagOff = progressFromRenderedStates();
      const fromEntry = orderedSteps(MVP_DEAL_RAIL).filter((step) => step.seq >= 12).length;
      expect(flagOff).toBe(
        `${8 + GATE0_ON_RAIL.length} of ${fromEntry + GATE0_ON_RAIL.length} steps done`,
      );
      expectWholeRail(flagOff);
      cleanup();

      vi.resetModules();
      state.flagOn = true;
      state.rail = serverRailEnteredAt(12, 20);
      await renderRail();
      openAllPhases();
      expect(progressFromRenderedStates()).toBe(flagOff);
      expectWholeRail(flagOff);
    });
  });
  describe('opens at the cursor', () => {
    type ScrollCall = { el: Element; options: ScrollIntoViewOptions | boolean | undefined };
    let scrollCalls: ScrollCall[] = [];
    let stackScrolls: { el: Element; value: number }[] = [];
    let wide = true;

    beforeEach(() => {
      scrollCalls = [];
      stackScrolls = [];
      wide = true;
      // jsdom implements neither; the board reads both on mount.
      Element.prototype.scrollIntoView = vi.fn(function (
        this: Element,
        options?: ScrollIntoViewOptions | boolean,
      ) {
        scrollCalls.push({ el: this, options });
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get: () => 0,
        set(this: HTMLElement, value: number) {
          stackScrolls.push({ el: this, value });
        },
      });
      window.matchMedia = vi.fn((query: string) => ({
        matches: query === '(min-width: 768px)' ? wide : false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })) as unknown as typeof window.matchMedia;
    });

    afterEach(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
      delete (window as { matchMedia?: unknown }).matchMedia;
    });

    function stepButton(id: string): HTMLElement {
      return within(screen.getByTestId(`step-${id}`)).getByRole('button', { name: /^Step / });
    }

    /** A deal opened partway down: three steps before the entry, the cursor on the fourth. */
    function railEnteredPartway(): ProjectRail {
      const picked = orderedSteps(MVP_DEAL_RAIL)
        .filter((step) => !GATE0_STEP_ID_SET.has(step.id))
        .slice(0, 6);
      return {
        currentStepId: 'uuid-4',
        canEditStructure: false,
        canSaveTemplate: false,
        phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
        steps: picked.map((step, index) =>
          serverStep({
            id: `uuid-${index + 1}`,
            stepId: step.id,
            phaseIndex: phaseForStep(step.id, MVP_DEAL_RAIL)?.index ?? 1,
            displayOrder: index + 1,
            seq: step.seq,
            status: index < 3 ? 'skipped_entry' : index === 3 ? 'current' : 'pending',
            catalog: step,
          }),
        ),
      };
    }

    it('opens the cursor phase and scrolls its own list to the cursor once, never the page, on md and wider', async () => {
      state.flagOn = true;
      state.rail = railEnteredPartway();
      await renderRail();

      const cursor = stepButton('uuid-4');
      expect(cursor).toHaveAttribute('aria-current', 'step');
      await waitFor(() => expect(stackScrolls).toHaveLength(1));
      expect(stackScrolls[0].el).toHaveAttribute('data-step-stack');
      expect(stackScrolls[0].el.contains(cursor)).toBe(true);
      expect(scrollCalls).toHaveLength(0);
    });

    it('leaves the page at the top below md', async () => {
      state.flagOn = true;
      wide = false;
      state.rail = railEnteredPartway();
      await renderRail();

      expect(stepButton('uuid-4')).toHaveAttribute('aria-current', 'step');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(scrollCalls).toHaveLength(0);
      expect(stackScrolls).toHaveLength(0);
    });

    it('never moves focus on load', async () => {
      state.flagOn = true;
      state.rail = railEnteredPartway();
      await renderRail();
      await waitFor(() => expect(stackScrolls).toHaveLength(1));

      expect(document.activeElement).not.toBe(stepButton('uuid-4'));
      expect(
        screen.getAllByRole('button', { name: /^Step / }).includes(document.activeElement as HTMLElement),
      ).toBe(false);
    });

    it('opens the phase of currentStepId even though no row has status "current"', async () => {
      state.flagOn = true;
      const [first, second] = orderedSteps(MVP_DEAL_RAIL).filter((step) => !step.gate0);
      state.rail = {
        currentStepId: 'uuid-2',
        canEditStructure: true,
        canSaveTemplate: false,
        phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
        steps: [
          serverStep({ stepId: first.id, seq: first.seq, status: 'complete', catalog: first }),
          serverStep({
            id: 'uuid-2',
            stepId: second.id,
            displayOrder: 2,
            seq: second.seq,
            status: 'pending',
            catalog: second,
          }),
        ],
      };
      await renderRail();

      expect(screen.getByRole('button', { name: MVP_DEAL_RAIL[0].name })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await waitFor(() => expect(stackScrolls).toHaveLength(1));
      expect(stackScrolls[0].el.contains(stepButton('uuid-2'))).toBe(true);
    });

    it('says where the deal opened, at both zoom levels', async () => {
      window.localStorage.setItem(
        'ib-fixture-deals',
        JSON.stringify([
          {
            id: 'deal-1',
            codename: 'Project Cedar',
            code: 'CED-2026-001',
            target: 'Cedar Labs',
            sector: 'Software',
            status: 'Origination',
            cursorStepId: stepIdForSeq(20, MVP_DEAL_RAIL),
            entryStepSeq: 12,
            gate0Complete: true,
            dealRole: 'Managing Director',
          },
        ]),
      );
      try {
        await renderRail();
        const catalog = orderedSteps(MVP_DEAL_RAIL);
        const entryIndex = catalog.findIndex((step) => step.seq === 12);
        const expected = `Opened at step ${String(entryIndex + 1).padStart(2, '0')} · ${catalog[entryIndex].title}`;
        expect(screen.getByTestId('rail-entry-line')).toHaveTextContent(expected);

        fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));
        expect(screen.getByRole('region', { name: 'Step detail' })).toBeInTheDocument();
        expect(screen.getByTestId('rail-entry-line')).toHaveTextContent(expected);
      } finally {
        window.localStorage.removeItem('ib-fixture-deals');
      }
    });

    it('does not scroll to the cursor while a ?step= deep link is zooming in', async () => {
      state.flagOn = true;
      state.rail = railEnteredPartway();
      const target = state.rail.steps.find((step) => step.id === 'uuid-5');
      state.search = new URLSearchParams(`step=${target?.seq}`);
      await renderRail();

      const focus = await screen.findByRole('region', { name: 'Step detail' });
      await waitFor(() =>
        expect(
          within(focus).getByRole('heading', { level: 2, name: new RegExp(target?.catalog?.title ?? '') }),
        ).toBeInTheDocument(),
      );
      expect(scrollCalls).toHaveLength(0);
      expect(stackScrolls).toHaveLength(0);
    });

    it('shows no entry line on a deal that opened at the start', async () => {
      await renderRail();
      expect(screen.queryByTestId('rail-entry-line')).not.toBeInTheDocument();
    });

    it('does not scroll to the cursor again on a return from a zoomed-in step', async () => {
      state.flagOn = true;
      state.rail = railEnteredPartway();
      await renderRail();
      await waitFor(() => expect(stackScrolls).toHaveLength(1));

      fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));
      expect(screen.getByRole('region', { name: 'Step detail' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^Zoom out to / }));
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(stepButton('uuid-4')).toHaveAttribute('aria-current', 'step');

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stackScrolls).toHaveLength(1);
    });

    it.each(['abc', '99999'])(
      'ignores a ?step= of %s that names no step and opens the board at the cursor',
      async (stepParam) => {
        state.flagOn = true;
        state.rail = railEnteredPartway();
        state.search = new URLSearchParams(`step=${stepParam}`);
        await renderRail();

        await waitFor(() => expect(stackScrolls).toHaveLength(1));
        expect(stackScrolls[0].el.contains(stepButton('uuid-4'))).toBe(true);
        expect(screen.getByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
      },
    );

    /** A finished deal: every step complete, no cursor. */
    function railAllComplete(): ProjectRail {
      const picked = orderedSteps(MVP_DEAL_RAIL)
        .filter((step) => !GATE0_STEP_ID_SET.has(step.id))
        .slice(0, 3);
      return {
        currentStepId: null,
        canEditStructure: false,
        canSaveTemplate: false,
        phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
        steps: picked.map((step, index) =>
          serverStep({
            id: `uuid-${index + 1}`,
            stepId: step.id,
            phaseIndex: phaseForStep(step.id, MVP_DEAL_RAIL)?.index ?? 1,
            displayOrder: index + 1,
            seq: step.seq,
            status: 'complete',
            catalog: step,
          }),
        ),
      };
    }

    it('rests a finished deal on the phase of its last step, with no current step to open', async () => {
      state.flagOn = true;
      state.rail = railAllComplete();
      const last = state.rail.steps[2];
      await renderRail();

      const lastPhase = MVP_DEAL_RAIL.find((p) => p.index === last.phaseIndex)!;
      expect(screen.getByRole('button', { name: lastPhase.name })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(stepButton('uuid-3')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open current step' })).not.toBeInTheDocument();
      expect(screen.getByTestId('rail-progress-line')).toHaveTextContent('3 of 3 steps done');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stackScrolls).toHaveLength(0);
    });
  });

  describe('skipping a station', () => {
    afterEach(() => {
      window.localStorage.removeItem('ib-fixture-deals');
    });

    it('flips the card to Skipped and counts it toward steps done', async () => {
      storeFixtureDeal({});
      await renderRail();
      fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));

      const cursorId = stepIdForSeq(20, MVP_DEAL_RAIL);
      const label = (): { done: number; total: number } => {
        const match = screen
          .getByRole('progressbar', { name: 'Rail progress', hidden: true })
          .getAttribute('aria-valuetext')
          ?.match(/^(\d+) of (\d+)/);
        if (!match) throw new Error('Expected a steps done label');
        return { done: Number(match[1]), total: Number(match[2]) };
      };
      const before = label();

      const focus = screen.getByRole('region', { name: 'Step detail' });
      fireEvent.click(within(focus).getByRole('button', { name: 'Skip…' }));
      const modal = await screen.findByRole('dialog', { name: /^Skip / });
      fireEvent.change(within(modal).getByRole('textbox'), {
        target: { value: 'Not needed for this deal.' },
      });
      fireEvent.click(within(modal).getByRole('button', { name: 'Skip step' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /^Skip / })).not.toBeInTheDocument(),
      );

      expect(label()).toEqual({ done: before.done + 1, total: before.total });

      fireEvent.click(screen.getByRole('button', { name: /^Zoom out to / }));
      await screen.findByRole('region', { name: 'Rail overview' });
      const card = stepById(cursorId);
      expect(card).toHaveAttribute('data-state', 'skipped');
      expect(within(card).getByText('Skipped')).toBeInTheDocument();
      expectWholeRail(`${before.done + 1} of ${before.total} steps done`);
    });
  });

  describe('browser history for the zoom (S6-01)', () => {
    /** Four catalogue steps in one phase, the cursor on the first. */
    function railInOnePhase(): ProjectRail {
      const phase = MVP_DEAL_RAIL[1];
      const picked = phase.steps.filter((step) => !GATE0_STEP_ID_SET.has(step.id)).slice(0, 4);
      return {
        currentStepId: 'uuid-1',
        canEditStructure: false,
        canSaveTemplate: false,
        phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
        steps: picked.map((step, index) =>
          serverStep({
            id: `uuid-${index + 1}`,
            stepId: step.id,
            phaseIndex: phase.index,
            displayOrder: index + 1,
            seq: step.seq,
            status: index === 0 ? 'current' : 'pending',
            catalog: step,
          }),
        ),
      };
    }

    let push: ReturnType<typeof vi.spyOn>;
    let replace: ReturnType<typeof vi.spyOn>;
    let back: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      window.history.replaceState(null, '', '/projects/deal-1/rail');
      // The rail sees its own pushed ?step=, as it does under Next.
      state.liveSearch = true;
      push = vi.spyOn(window.history, 'pushState');
      replace = vi.spyOn(window.history, 'replaceState');
      // The mock stands in for the browser: Back is recorded, and the test
      // fires the popstate the browser would.
      back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    });
    afterEach(() => {
      push.mockRestore();
      replace.mockRestore();
      back.mockRestore();
      window.history.replaceState(null, '', '/');
    });

    function popTo(state: unknown, url: string) {
      window.history.replaceState(state, '', url);
      fireEvent(window, new PopStateEvent('popstate', { state }));
    }

    async function zoomIntoSecondStep() {
      const rail = railInOnePhase();
      state.flagOn = true;
      state.rail = rail;
      await renderRail();
      const second = rail.steps[1];
      fireEvent.click(
        within(screen.getByTestId('step-uuid-2')).getByRole('button', { name: /^Step / }),
      );
      const detail = screen.getByRole('region', { name: 'Step detail' });
      expect(within(detail).getByRole('heading', { level: 2, name: stepTitleOf(second) })).toBeInTheDocument();
      return rail;
    }

    function stepTitleOf(step: ProjectRailStep): string {
      return step.catalog?.title ?? '';
    }

    it('pushes one shallow ?step= entry on zoom-in', async () => {
      const rail = await zoomIntoSecondStep();
      expect(push).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe(`?step=${rail.steps[1].seq}`);
      expect(window.history.state).toMatchObject({ conductiaRailZoom: { deal: 'deal-1', step: 'uuid-2' } });
    });

    it('replaces that entry on Previous and Next, never adding one per step', async () => {
      const rail = await zoomIntoSecondStep();
      const detail = screen.getByRole('region', { name: 'Step detail' });
      fireEvent.click(within(within(detail).getByRole('navigation', { name: 'Next step' })).getByRole('button'));
      await waitFor(() => expect(window.location.search).toBe(`?step=${rail.steps[2].seq}`));
      fireEvent.click(
        within(within(screen.getByRole('region', { name: 'Step detail' })).getByRole('navigation', { name: 'Previous step' })).getByRole('button'),
      );
      await waitFor(() => expect(window.location.search).toBe(`?step=${rail.steps[1].seq}`));
      expect(push).toHaveBeenCalledTimes(1);
      expect(window.history.state).toMatchObject({ conductiaRailZoom: { step: 'uuid-2' } });
    });

    it('browser Back zooms out to the step phase, and Forward zooms back in', async () => {
      const rail = await zoomIntoSecondStep();
      const zoomEntry = window.history.state;
      const zoomUrl = `${window.location.pathname}${window.location.search}`;

      popTo(null, '/projects/deal-1/rail');
      const board = await screen.findByRole('region', { name: 'Rail overview' });
      expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
      expect(within(board).getByRole('button', { name: MVP_DEAL_RAIL[1].name, exact: true } as never)).toHaveAttribute('aria-expanded', 'true');
      expect(back).not.toHaveBeenCalled();

      popTo(zoomEntry, zoomUrl);
      const detail = await screen.findByRole('region', { name: 'Step detail' });
      expect(within(detail).getByRole('heading', { level: 2, name: stepTitleOf(rail.steps[1]) })).toBeInTheDocument();
      expect(push).toHaveBeenCalledTimes(1);
    });

    it('Esc and the zoom-out button still zoom out at once, and step back off the entry', async () => {
      await zoomIntoSecondStep();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(back).toHaveBeenCalledTimes(1);
      // The browser's popstate for that step changes nothing more.
      popTo(null, '/projects/deal-1/rail');
      expect(screen.getByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(push).toHaveBeenCalledTimes(1);

      fireEvent.click(within(screen.getByTestId('step-uuid-3')).getByRole('button', { name: /^Step / }));
      expect(push).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: /^Zoom out to / }));
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(back).toHaveBeenCalledTimes(2);
    });

    it('a ?step= deep link still lands zoomed in and adds no history entry', async () => {
      const rail = railInOnePhase();
      state.flagOn = true;
      state.rail = rail;
      window.history.replaceState(null, '', `/projects/deal-1/rail?step=${rail.steps[2].seq}`);
      await renderRail();
      const detail = await screen.findByRole('region', { name: 'Step detail' });
      expect(within(detail).getByRole('heading', { level: 2, name: stepTitleOf(rail.steps[2]) })).toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();
    });

    /**
     * The browser has moved off the zoom entry (its marker is gone) while the
     * router still reports the entry's ?step=: the window between popstate
     * and Next's traverse transition.
     */
    function popWithStaleParam() {
      const stale = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', stale);
      fireEvent(window, new PopStateEvent('popstate', { state: null }));
    }

    it('Back zooms out and stays out while the router still reports the old ?step=', async () => {
      const rail = await zoomIntoSecondStep();
      expect(window.location.search).toBe(`?step=${rail.steps[1].seq}`);

      popWithStaleParam();
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
      expect(push).toHaveBeenCalledTimes(1);

      // The router catches up: the param goes, and the board stays.
      window.history.replaceState(null, '', '/projects/deal-1/rail');
      fireEvent.click(screen.getByRole('button', { name: MVP_DEAL_RAIL[1].name, exact: true } as never));
      expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
    });

    it('Esc then a new zoom before the Back lands gives one zoom, one entry, and one Back', async () => {
      const rail = await zoomIntoSecondStep();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(back).toHaveBeenCalledTimes(1);

      // Zoom into another step while the browser is still on the old entry.
      fireEvent.click(within(screen.getByTestId('step-uuid-3')).getByRole('button', { name: /^Step / }));
      expect(screen.getByRole('region', { name: 'Step detail' })).toBeInTheDocument();
      expect(push).toHaveBeenCalledTimes(1);

      // The Back lands on the board's entry: the new zoom gets its entry then.
      popTo(null, '/projects/deal-1/rail');
      const detail = await screen.findByRole('region', { name: 'Step detail' });
      expect(within(detail).getByRole('heading', { level: 2, name: stepTitleOf(rail.steps[2]) })).toBeInTheDocument();
      expect(push).toHaveBeenCalledTimes(2);
      expect(window.history.state).toMatchObject({ conductiaRailZoom: { step: 'uuid-3' } });
      expect(window.location.search).toBe(`?step=${rail.steps[2].seq}`);
      expect(back).toHaveBeenCalledTimes(1);
    });

    it('a ?step= deep link keeps ?step= in the address bar, adopted in place with no new entry (S6R4-04)', async () => {
      const rail = railInOnePhase();
      state.flagOn = true;
      state.rail = rail;
      window.history.replaceState(null, '', `/projects/deal-1/rail?step=${rail.steps[2].seq}`);
      router.replace.mockClear();
      await renderRail();
      await screen.findByRole('region', { name: 'Step detail' });
      await waitFor(() =>
        expect(window.history.state).toMatchObject({
          conductiaRailZoom: { deal: 'deal-1', step: 'uuid-3', link: true },
        }),
      );
      expect(window.location.search).toBe(`?step=${rail.steps[2].seq}`);
      // Replaced, never pushed: Back still leaves the page.
      expect(push).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();

      // Next walks the adopted entry, still without a new one.
      fireEvent.click(
        within(within(screen.getByRole('region', { name: 'Step detail' })).getByRole('navigation', { name: 'Next step' })).getByRole('button'),
      );
      await waitFor(() => expect(window.location.search).toBe(`?step=${rail.steps[3].seq}`));
      expect(window.history.state).toMatchObject({ conductiaRailZoom: { step: 'uuid-4', link: true } });
      expect(push).not.toHaveBeenCalled();

      // Esc zooms out as today: no step back, and the entry is plain again.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(back).not.toHaveBeenCalled();
      expect(window.location.search).toBe('');
      expect(window.history.state).not.toMatchObject({ conductiaRailZoom: expect.anything() });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
    });

    /**
     * Next's router updates useSearchParams in a transition, so the render
     * right after leaving still reports the old ?step=. Pin the search at the
     * walked step for that window (no live window.location read).
     */
    function lagSearchAt(seq: number | null) {
      state.liveSearch = false;
      state.search = new URLSearchParams(`step=${seq}`);
    }

    async function expectBoardStays() {
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
    }

    async function landOnLinkThenNext() {
      const rail = railInOnePhase();
      state.flagOn = true;
      state.rail = rail;
      window.history.replaceState(null, '', `/projects/deal-1/rail?step=${rail.steps[2].seq}`);
      await renderRail();
      await screen.findByRole('region', { name: 'Step detail' });
      await waitFor(() => expect(window.history.state).toMatchObject({ conductiaRailZoom: { link: true } }));
      fireEvent.click(
        within(within(screen.getByRole('region', { name: 'Step detail' })).getByRole('navigation', { name: 'Next step' })).getByRole('button'),
      );
      await waitFor(() => expect(window.location.search).toBe(`?step=${rail.steps[3].seq}`));
      return rail;
    }

    it.each(['Esc', 'the zoom-out button'])(
      '%s after Next on an adopted deep link stays on the board while the router still reports the walked ?step= (S6R4-R2 I-1)',
      async (exit) => {
        const rail = await landOnLinkThenNext();
        lagSearchAt(rail.steps[3].seq);
        if (exit === 'Esc') fireEvent.keyDown(document.body, { key: 'Escape' });
        else fireEvent.click(screen.getByRole('button', { name: /^Zoom out to / }));
        await expectBoardStays();
        expect(window.location.search).toBe('');
        expect(back).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
      },
    );

    it.each(['Esc', 'the zoom-out button'])(
      '%s after Next on a pushed zoom stays on the board while the router still reports the walked ?step=',
      async (exit) => {
        const rail = await zoomIntoSecondStep();
        fireEvent.click(
          within(within(screen.getByRole('region', { name: 'Step detail' })).getByRole('navigation', { name: 'Next step' })).getByRole('button'),
        );
        await waitFor(() => expect(window.location.search).toBe(`?step=${rail.steps[2].seq}`));
        lagSearchAt(rail.steps[2].seq);
        if (exit === 'Esc') fireEvent.keyDown(document.body, { key: 'Escape' });
        else fireEvent.click(screen.getByRole('button', { name: /^Zoom out to / }));
        await expectBoardStays();
        expect(back).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledTimes(1);
      },
    );

    it('the zoom-out button on an adopted deep link zooms out without stepping back', async () => {
      const rail = railInOnePhase();
      state.flagOn = true;
      state.rail = rail;
      window.history.replaceState(null, '', `/projects/deal-1/rail?step=${rail.steps[2].seq}`);
      await renderRail();
      await screen.findByRole('region', { name: 'Step detail' });
      await waitFor(() => expect(window.history.state).toMatchObject({ conductiaRailZoom: { link: true } }));
      fireEvent.click(screen.getByRole('button', { name: /^Zoom out to / }));
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(back).not.toHaveBeenCalled();
      expect(window.location.search).toBe('');

      // A zoom from the board afterwards pushes its own entry, as before.
      fireEvent.click(within(screen.getByTestId('step-uuid-2')).getByRole('button', { name: /^Step / }));
      expect(push).toHaveBeenCalledTimes(1);
      expect(window.history.state).toMatchObject({ conductiaRailZoom: { step: 'uuid-2' } });
      expect(window.history.state.conductiaRailZoom.link).toBeUndefined();
    });

    it('Esc on a ?step= deep-link landing zooms out without stepping back in history', async () => {
      const rail = railInOnePhase();
      state.flagOn = true;
      state.rail = rail;
      window.history.replaceState(null, '', `/projects/deal-1/rail?step=${rail.steps[2].seq}`);
      await renderRail();
      await screen.findByRole('region', { name: 'Step detail' });

      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(await screen.findByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(back).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it('a reload on a zoom entry opens the board and makes the entry plain', async () => {
      const rail = railInOnePhase();
      window.history.replaceState(
        { conductiaRailZoom: { deal: 'deal-1', step: 'uuid-2' } },
        '',
        `/projects/deal-1/rail?step=${rail.steps[1].seq}`,
      );
      state.flagOn = true;
      state.rail = rail;
      await renderRail();
      expect(screen.getByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Step detail' })).not.toBeInTheDocument();
      expect(window.location.search).toBe('');
      expect(window.history.state).not.toMatchObject({ conductiaRailZoom: expect.anything() });
    });
  });
});
