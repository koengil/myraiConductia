import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';

import { submitSkip } from '@/lib/rail/submitSkip';
import { CustomStepPanel } from '@/components/rail/CustomStepPanel';
import { StepCard } from '@/components/rail/StepCard';
import {
  MVP_DEAL_RAIL,
  orderedSteps,
  phaseForStep,
  RELATIONSHIP_PATHING_STEP_ID,
  stepAgentFeatures,
  stepIdForSeq,
  TEASER_STEP_ID,
  type RailStep,
} from '@/lib/rail/dealRail';
import { MANUAL_STEP_IDS } from '@/lib/rail/manualStepDefs';
import { processTagForRailStep } from '@/lib/ignatious/processTag';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';
import { OPEN_DRAFT_BUTTON } from '../helpers/draftButton';

function step(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: 'uuid-1',
    stepId: 'custom:abc',
    origin: 'custom',
    phaseIndex: 2,
    displayOrder: 5,
    seq: null,
    status: 'pending',
    definition: { title: 'Weekly project update', description: 'd' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

const dealRailFixture = { rail: null as ProjectRail | null };

// Mutable per test: the rail model flag is on by default, skill authoring off.
const env = vi.hoisted(() => ({
  flags: new Set<string>(['project_rail_model']),
  search: new URLSearchParams(),
}));

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => env.flags.has(key),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'deal-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/projects/deal-1',
  useSearchParams: () => env.search,
}));

// The custom runner fetches its own versions; a marker is enough to see it mount.
vi.mock('@/components/rail/SkillStepRunner', () => ({
  SkillStepRunner: () => <div data-testid="skill-step-runner" />,
}));

beforeEach(() => {
  env.flags = new Set(['project_rail_model']);
  env.search = new URLSearchParams();
});

describe('submitSkip', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  });

  it('posts the approver and reason to the skip route', async () => {
    await submitSkip('deal-1', 'uuid-1', { approverId: 'user-2', reason: 'Handled off platform' });

    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/v1/deals/deal-1/rail/steps/uuid-1/skip');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      approverId: 'user-2',
      reason: 'Handled off platform',
    });
  });

  it('rejects a blank reason without calling the server', async () => {
    await expect(
      submitSkip('deal-1', 'uuid-1', { approverId: 'user-2', reason: '   ' }),
    ).rejects.toThrow(/reason/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('writes nothing to browser storage', async () => {
    await submitSkip('deal-1', 'uuid-1', { approverId: 'user-2', reason: 'Handled off platform' });
    expect(Object.keys(window.localStorage).some((key) => key.includes('skip'))).toBe(false);
  });
});

describe('StepCard skip state', () => {
  it('renders the skip from the step record', () => {
    render(
      <StepCard
        step={step({
          status: 'skipped',
          skip: {
            at: '2026-09-09T10:00:00Z',
            by: 'user-2',
            approver: 'Avery Lindqvist',
            reason: 'Handled off platform',
          },
        })}
      />,
    );
    expect(screen.getByText(/Avery Lindqvist/)).toBeInTheDocument();
    expect(screen.getByText(/Handled off platform/)).toBeInTheDocument();
  });

  it('renders as skipped but stays on the active rail rather than disappearing', () => {
    render(
      <StepCard
        step={step({
          status: 'skipped',
          skip: {
            at: '2026-09-09T10:00:00Z',
            by: 'user-2',
            approver: 'Avery Lindqvist',
            reason: 'Handled off platform',
          },
        })}
      />,
    );
    expect(screen.getByTestId('step-uuid-1')).toHaveAttribute('data-state', 'skipped');
    expect(screen.getByTestId('step-uuid-1')).toHaveAttribute('data-status', 'skipped');
  });

  it('ignores a conflicting skip left in browser storage', () => {
    window.localStorage.setItem(
      'rail-run-state',
      JSON.stringify({ skips: { 'uuid-1': { approver: 'Stale Approver', reason: 'Stale' } } }),
    );
    render(<StepCard step={step({ status: 'pending' })} />);
    expect(screen.queryByText(/Stale Approver/)).not.toBeInTheDocument();
  });

  it('renders a pre-entry step as "Before this deal started": muted, never faded, with no completion credit', () => {
    render(<StepCard step={step({ status: 'skipped_entry' })} completedBy="Storm Duncan" />);
    const card = screen.getByTestId('step-uuid-1');
    expect(card).toHaveAttribute('data-state', 'prior');
    expect(card).toHaveAttribute('data-status', 'skipped_entry');
    // One quiet line: the state reads from the card's name and its tooltip.
    const open = within(card).getByRole('button', { name: /· Before this deal started$/ });
    expect(open).toHaveAttribute('title', 'Before this deal started');
    expect(card.className).not.toContain('opacity-70');
    expect(card.className).not.toContain('border-dashed');
    expect(card.textContent).not.toContain('Storm Duncan');
    // No completion credit of any kind, not even the hidden layout placeholder.
    expect(within(card).queryByText(/Completed by/)).toBeNull();
    expect(card.textContent).not.toMatch(/Completed by/);
    // Reference only: no action, run or skip control on the card.
    expect(within(card).queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: OPEN_DRAFT_BUTTON })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Skip/ })).not.toBeInTheDocument();
    expect(within(card).queryByTestId('skill-step-runner')).not.toBeInTheDocument();
    expect(within(card).getAllByRole('button')).toHaveLength(1);
  });

  it('still renders a skipped step dashed, "Skipped", with its completion credit', () => {
    render(
      <StepCard
        step={step({
          status: 'skipped',
          skip: {
            at: '2026-09-09T10:00:00Z',
            by: 'user-2',
            approver: 'Avery Lindqvist',
            reason: 'Handled off platform',
          },
        })}
        completedBy="Avery Lindqvist"
      />,
    );
    const card = screen.getByTestId('step-uuid-1');
    expect(card).toHaveAttribute('data-state', 'skipped');
    expect(card.className).toContain('border-dashed');
    expect(within(card).getByText('Skipped')).toBeInTheDocument();
    expect(within(card).getByText('Completed by: Avery Lindqvist')).toBeInTheDocument();
  });
});

describe('CustomStepPanel run controls', () => {
  beforeEach(() => {
    env.flags.add('skill_authoring');
  });

  it('offers the runner and the honest advance-only button on an active custom step', () => {
    render(
      <CustomStepPanel step={step({ status: 'current' })} state="active" dealId="deal-1" onComplete={() => {}} />,
    );
    expect(screen.getByTestId('skill-step-runner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to the next step' })).toHaveAccessibleDescription(
      "This moves the deal's current step. It does not record this step as done.",
    );
  });

  it('offers no advance on a custom step that is not the current step: it would record nothing', () => {
    render(
      <CustomStepPanel step={step({ status: 'pending' })} state="todo" dealId="deal-1" onComplete={() => {}} />,
    );
    expect(screen.getByTestId('skill-step-runner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark complete|Move to the next step/ })).not.toBeInTheDocument();
  });

  it('offers no runner and no Mark complete on a pre-entry custom step', () => {
    render(
      <CustomStepPanel
        step={step({ status: 'skipped_entry' })}
        state="prior"
        dealId="deal-1"
        onComplete={() => {}}
      />,
    );
    expect(screen.getByText('Before this deal started')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-step-runner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark complete|Move to the next step/ })).not.toBeInTheDocument();
  });

  it('offers no runner and no Mark complete on a skipped custom step', () => {
    render(
      <CustomStepPanel step={step({ status: 'skipped' })} state="skipped" dealId="deal-1" onComplete={() => {}} />,
    );
    expect(screen.queryByTestId('skill-step-runner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark complete|Move to the next step/ })).not.toBeInTheDocument();
  });
});

describe('Skip control reachable through DealRail', () => {
  const nonProtectedCatalogStep = orderedSteps(MVP_DEAL_RAIL).find(
    (candidate) => !candidate.gate0,
  );
  if (!nonProtectedCatalogStep) {
    throw new Error('Expected at least one non-gate0 catalogue step for this fixture');
  }

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

  beforeEach(() => {
    dealRailFixture.rail = {
      currentStepId: 'uuid-1',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        {
          id: 'uuid-1',
          stepId: nonProtectedCatalogStep.id,
          origin: 'catalog',
          phaseIndex: 1,
          displayOrder: 1,
          seq: nonProtectedCatalogStep.seq,
          status: 'current',
          definition: null,
          anchorStepId: null,
          removedAt: null,
          removedBy: null,
          skip: null,
          catalog: nonProtectedCatalogStep,
        },
      ],
    };
    vi.resetModules();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) {
        return { ok: true, json: async () => dealRailFixture.rail } as Response;
      }
      if (url.includes('/api/v1/me')) {
        return { ok: true, json: async () => ME } as Response;
      }
      // The live Skip modal lists the deal's eligible seats from the step GET (#312).
      if (url.includes(`/steps/${nonProtectedCatalogStep.id}`)) {
        return {
          ok: true,
          json: async () => ({
            members: [{ id: ME.user.id, name: ME.user.display_name, dealRole: 'md', status: 'active' }],
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;
  });

  it('reaches an enabled Skip control through DealRail -> StepZoom -> StepContract', async () => {
    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    await waitFor(() =>
      expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));

    const focus = screen.getByRole('region', { name: 'Step detail' });
    expect(within(focus).getByRole('button', { name: 'Skip…' })).toBeEnabled();
  });

  it('posts the approver and reason to the skip route and refreshes the rail on confirm', async () => {
    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    await waitFor(() =>
      expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));

    const focus = screen.getByRole('region', { name: 'Step detail' });
    fireEvent.click(within(focus).getByRole('button', { name: 'Skip…' }));

    const modal = await screen.findByRole('dialog', {
      name: new RegExp(`^Skip ${nonProtectedCatalogStep.title}`),
    });
    fireEvent.change(within(modal).getByRole('textbox'), {
      target: { value: 'Not needed for this deal.' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: 'Skip step' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /^Skip / })).not.toBeInTheDocument(),
    );

    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const skipCall = calls.find((call) => String(call[0]).includes('/skip'));
    if (!skipCall) throw new Error('Expected a POST to the skip route');
    const [url, init] = skipCall;
    expect(url).toBe('/api/v1/deals/deal-1/rail/steps/uuid-1/skip');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { approverId: string; reason: string };
    expect(body.reason).toBe('Not needed for this deal.');
    expect(typeof body.approverId).toBe('string');
    expect(body.approverId.length).toBeGreaterThan(0);
    expect(body.approverId).toBe(ME.user.id);

    const railCalls = calls.filter((call) => String(call[0]).includes('/rail') && !String(call[0]).includes('/skip'));
    expect(railCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Rail cursor follows currentStepId, not step status', () => {
  const [firstStep, secondStep] = orderedSteps(MVP_DEAL_RAIL).filter(
    (candidate) => !candidate.gate0,
  );

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

  beforeEach(() => {
    vi.resetModules();
    const rail: ProjectRail = {
      currentStepId: 'uuid-2',
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        {
          id: 'uuid-1',
          stepId: firstStep.id,
          origin: 'catalog',
          phaseIndex: 1,
          displayOrder: 1,
          seq: firstStep.seq,
          status: 'complete',
          definition: null,
          anchorStepId: null,
          removedAt: null,
          removedBy: null,
          skip: null,
          catalog: firstStep,
        },
        {
          id: 'uuid-2',
          stepId: secondStep.id,
          origin: 'catalog',
          phaseIndex: 1,
          displayOrder: 2,
          seq: secondStep.seq,
          status: 'pending',
          definition: null,
          anchorStepId: null,
          removedAt: null,
          removedBy: null,
          skip: null,
          catalog: secondStep,
        },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/rail')) {
        return { ok: true, json: async () => rail } as Response;
      }
      if (url.includes('/api/v1/me')) {
        return { ok: true, json: async () => ME } as Response;
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;
  });

  it('zooms into the step named by currentStepId even though no row has status "current"', async () => {
    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    await waitFor(() =>
      expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open current step' }));

    expect(
      await screen.findByRole('heading', { level: 2, name: (name) => name.includes(secondStep.title) }),
    ).toBeInTheDocument();
  });
});

describe('Reference-only steps, zoomed in (?step=)', () => {
  const PRIOR_FOOTER = 'Happened before this deal opened in Conductia. Reference only.';
  const catalog = orderedSteps(MVP_DEAL_RAIL);
  const byId = (id: string): RailStep => {
    const found = catalog.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`Expected catalogue step ${id}`);
    return found;
  };
  const cursorStep = byId('p3-s44');
  const pathingStep = byId(RELATIONSHIP_PATHING_STEP_ID);
  const manualStep = byId('p1-s10');
  const liveStep = byId(TEASER_STEP_ID);
  const taggedStep = byId('p1-s10');
  const agentStep = byId('p1-s17');

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

  function row(
    id: string,
    catalogStep: RailStep,
    status: ProjectRailStep['status'],
    displayOrder: number,
  ): ProjectRailStep {
    return {
      id,
      stepId: catalogStep.id,
      origin: 'catalog',
      phaseIndex: phaseForStep(catalogStep.id, MVP_DEAL_RAIL)?.index ?? 1,
      displayOrder,
      seq: catalogStep.seq,
      status,
      definition: null,
      anchorStepId: null,
      removedAt: null,
      removedBy: null,
      skip:
        status === 'skipped'
          ? { at: '2026-09-09T10:00:00Z', by: 'user-2', approver: 'Avery Lindqvist', reason: 'Handled off platform' }
          : null,
      catalog: catalogStep,
    };
  }

  function serveRail(rail: ProjectRail | null) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (rail && url.includes('/rail')) {
        return { ok: true, json: async () => rail } as Response;
      }
      if (url.includes('/api/v1/me')) {
        return { ok: true, json: async () => ME } as Response;
      }
      // The tagged step's skill resolves (the draft button waits for this read).
      if (url.endsWith('/skill-versions')) {
        return { ok: true, json: async () => ({ current: { kind: 'catalog', skillId: 's', versionId: 'v' }, catalog: [] }) } as Response;
      }
      if (url.endsWith('/skill-runs')) return { ok: true, json: async () => ({ runs: [] }) } as Response;
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) } as Response;
    }) as unknown as typeof fetch;
  }

  /** Zooms into `target` (via ?step=) on a server rail whose cursor sits later. */
  async function openInFocus(target: RailStep, status: ProjectRailStep['status']) {
    vi.resetModules();
    serveRail({
      currentStepId: 'uuid-cursor',
      canEditStructure: false,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [row('uuid-target', target, status, 1), row('uuid-cursor', cursorStep, 'current', 2)],
    });
    env.search = new URLSearchParams(`step=${target.seq}`);
    return renderFocusOn(target);
  }

  async function renderFocusOn(target: RailStep) {
    const { DealRail } = await import('@/components/rail/DealRail');
    render(<DealRail />);
    await waitFor(() =>
      expect(screen.queryByText(/Loading the deal rail/i)).not.toBeInTheDocument(),
    );
    // The deep link zooms in on the next frame.
    const focus = await screen.findByRole('region', { name: 'Step detail' });
    await waitFor(() =>
      expect(
        within(focus).getByRole('heading', { level: 2, name: new RegExp(target.title) }),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(within(focus).queryByText('Loading this step…')).not.toBeInTheDocument());
    return focus;
  }

  function expectNoRunOrActionControls(focus: HTMLElement) {
    expect(within(focus).queryByRole('button', { name: OPEN_DRAFT_BUTTON })).not.toBeInTheDocument();
    expect(within(focus).queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument();
    expect(within(focus).queryByRole('button', { name: 'Skip…' })).not.toBeInTheDocument();
    expect(within(focus).queryByTestId('skill-step-runner')).not.toBeInTheDocument();
    expect(within(focus).queryByText(/^Manual step\. Complete it/)).not.toBeInTheDocument();
  }

  afterEach(() => {
    window.localStorage.removeItem('ib-fixture-deals');
  });

  it('the fixtures cover what they claim', () => {
    expect(pathingStep.id).toBe('p1-s8');
    expect(MANUAL_STEP_IDS.has(manualStep.id) && !manualStep.live).toBe(true);
    expect(Boolean(liveStep.live)).toBe(true);
    expect(processTagForRailStep(taggedStep.id)).not.toBeNull();
    expect(stepAgentFeatures(taggedStep)).toHaveLength(0);
    expect(Boolean(taggedStep.live)).toBe(false);
    expect(stepAgentFeatures(agentStep).length).toBeGreaterThan(0);
  });

  it('offers the draft button on the same step while it is still ahead (control)', async () => {
    const focus = await openInFocus(taggedStep, 'pending');
    expect(await within(focus).findByRole('button', { name: OPEN_DRAFT_BUTTON })).toBeInTheDocument();
  });

  it('reads a pre-entry relationship pathing step as reference only, with no pathing panel', async () => {
    const focus = await openInFocus(pathingStep, 'skipped_entry');
    expect(within(focus).getByText(PRIOR_FOOTER)).toBeInTheDocument();
    expect(within(focus).queryByText(/^Complete\./)).not.toBeInTheDocument();
    expect(focus.querySelector('section[aria-label="Relationship pathing"]')).toBeNull();
    expect(focus.querySelector('section[aria-label="Manual step work"]')).toBeNull();
    expectNoRunOrActionControls(focus);
  });

  it('reads a pre-entry manual step as reference only, with no manual-step panel', async () => {
    const focus = await openInFocus(manualStep, 'skipped_entry');
    expect(within(focus).getByText(PRIOR_FOOTER)).toBeInTheDocument();
    expect(within(focus).queryByText(/^Complete\./)).not.toBeInTheDocument();
    expect(focus.querySelector('section[aria-label="Manual step work"]')).toBeNull();
    expect(focus.querySelector('section[aria-label="Relationship pathing"]')).toBeNull();
    expectNoRunOrActionControls(focus);
  });

  it.each([
    ['live', () => liveStep],
    ['skill-backed (process tag)', () => taggedStep],
    ['agent-backed', () => agentStep],
  ])('offers no draft button and no run controls on a pre-entry %s step', async (_label, pick) => {
    const focus = await openInFocus(pick(), 'skipped_entry');
    expect(within(focus).getByText(PRIOR_FOOTER)).toBeInTheDocument();
    expectNoRunOrActionControls(focus);
  });

  it.each([
    ['live', () => liveStep],
    ['skill-backed (process tag)', () => taggedStep],
    ['agent-backed', () => agentStep],
  ])('offers no draft button and no run controls on a skipped %s step', async (_label, pick) => {
    const focus = await openInFocus(pick(), 'skipped');
    expect(
      within(focus).getByText('Skipped with an approved, logged reason. The record stays.'),
    ).toBeInTheDocument();
    expect(within(focus).queryByText(PRIOR_FOOTER)).not.toBeInTheDocument();
    expectNoRunOrActionControls(focus);
  });

  it('closes an open runner when the zoom walks to a pre-entry step', async () => {
    vi.resetModules();
    serveRail({
      currentStepId: 'uuid-cursor',
      canEditStructure: false,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
      steps: [
        row('uuid-prior', pathingStep, 'skipped_entry', 1),
        row('uuid-target', taggedStep, 'pending', 2),
        row('uuid-cursor', cursorStep, 'current', 3),
      ],
    });
    env.search = new URLSearchParams(`step=${taggedStep.seq}`);
    const focus = await renderFocusOn(taggedStep);
    // Landing zoomed in drops ?step= from the URL (the mocked router does not).
    env.search = new URLSearchParams();

    fireEvent.click(await within(focus).findByRole('button', { name: OPEN_DRAFT_BUTTON }));
    expect(within(focus).getByTestId('skill-step-runner')).toBeInTheDocument();
    expect(within(focus).getByRole('button', { name: 'Close runner' })).toBeInTheDocument();

    fireEvent.click(
      within(focus).getByRole('button', { name: `Previous step · ${pathingStep.title}` }),
    );
    await waitFor(() =>
      expect(
        within(focus).getByRole('heading', { level: 2, name: new RegExp(pathingStep.title) }),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(within(focus).queryByText('Loading this step…')).not.toBeInTheDocument());
    expect(within(focus).getByText(PRIOR_FOOTER)).toBeInTheDocument();
    expect(within(focus).queryByRole('button', { name: 'Close runner' })).not.toBeInTheDocument();
    // The step walked away from slides out before it leaves the page.
    await waitFor(() => expectNoRunOrActionControls(focus));
  });

  it('offers no live rerun on a pre-entry live step with the rail model flag off', async () => {
    vi.resetModules();
    env.flags = new Set();
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
          cursorStepId: stepIdForSeq(40, MVP_DEAL_RAIL),
          entryStepSeq: 40,
          gate0Complete: true,
          dealRole: 'Managing Director',
        },
      ]),
    );
    serveRail(null);
    env.search = new URLSearchParams(`step=${liveStep.seq}`);
    const focus = await renderFocusOn(liveStep);
    expect(within(focus).getByText(PRIOR_FOOTER)).toBeInTheDocument();
    expect(within(focus).queryByText(/^Complete\./)).not.toBeInTheDocument();
    expectNoRunOrActionControls(focus);
  });
});
