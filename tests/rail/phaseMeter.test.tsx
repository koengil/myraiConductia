import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';

import {
  PhaseMeter,
  phaseCountFromRail,
  currentPhaseIndexFromRail,
  currentPhasePositionFromRail,
} from '@/components/rail/PhaseMeter';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';
import { SEED_DEALS } from '@/lib/rail/deals';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import type { FlagMap } from '@/lib/flags/resolveFlags';

function step(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: 'uuid-1',
    stepId: 'p1-s1',
    origin: 'catalog',
    phaseIndex: 1,
    displayOrder: 1,
    seq: 1,
    status: 'pending',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

function rail(overrides: Partial<ProjectRail> = {}): ProjectRail {
  return {
    currentStepId: null,
    canEditStructure: true,
    canSaveTemplate: false,
    phases: [
      { index: 1, name: 'Mandate', dealStatus: 'intake' },
      { index: 2, name: 'Marketing', dealStatus: 'active' },
    ],
    steps: [],
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('phaseCountFromRail', () => {
  it('excludes a phase whose steps were all removed', () => {
    const withRemoval = rail({
      steps: [
        step({ id: 's1', phaseIndex: 1, status: 'complete' }),
        step({ id: 's2', phaseIndex: 2, removedAt: '2026-09-09T10:00:00Z' }),
      ],
    });
    expect(phaseCountFromRail(withRemoval)).toBe(1);
  });

  it('counts every phase with at least one active step', () => {
    const bothActive = rail({
      steps: [
        step({ id: 's1', phaseIndex: 1, status: 'complete' }),
        step({ id: 's2', phaseIndex: 2, status: 'pending' }),
      ],
    });
    expect(phaseCountFromRail(bothActive)).toBe(2);
  });
});

describe('currentPhaseIndexFromRail', () => {
  it('reports no active phase when the project has no current step, not phase 1 or completion', () => {
    const noCursor = rail({
      currentStepId: null,
      steps: [step({ id: 's1', phaseIndex: 1, status: 'complete' })],
    });
    expect(currentPhaseIndexFromRail(noCursor)).toBe(0);
  });

  it('never anchors the current position on a removed step', () => {
    const staleCursor = rail({
      currentStepId: 's2',
      steps: [
        step({ id: 's1', phaseIndex: 1, status: 'complete' }),
        step({ id: 's2', phaseIndex: 2, removedAt: '2026-09-09T10:00:00Z' }),
      ],
    });
    expect(currentPhaseIndexFromRail(staleCursor)).toBe(0);
  });

  it('reads the current phase from the active step matching currentStepId', () => {
    const withCursor = rail({
      currentStepId: 's2',
      steps: [
        step({ id: 's1', phaseIndex: 1, status: 'complete' }),
        step({ id: 's2', phaseIndex: 2, status: 'current' }),
      ],
    });
    expect(currentPhaseIndexFromRail(withCursor)).toBe(2);
  });
});

describe('currentPhasePositionFromRail', () => {
  it('counts the position among populated phases, so it never exceeds the count', () => {
    const gapped = rail({
      currentStepId: 's2',
      phases: [
        { index: 1, name: 'Mandate', dealStatus: 'intake' },
        { index: 2, name: 'Marketing', dealStatus: 'active' },
        { index: 3, name: 'Diligence', dealStatus: 'active' },
      ],
      steps: [
        step({ id: 's1', phaseIndex: 1, status: 'complete' }),
        step({ id: 's2', phaseIndex: 3, status: 'current' }),
      ],
    });
    expect(currentPhaseIndexFromRail(gapped)).toBe(3);
    expect(phaseCountFromRail(gapped)).toBe(2);
    expect(currentPhasePositionFromRail(gapped)).toBe(2);
  });
});

describe('PhaseMeter', () => {
  it('never renders a position past the count when a phase has no active step', () => {
    render(
      <PhaseMeter
        withCaption
        rail={rail({
          currentStepId: 's2',
          phases: [
            { index: 1, name: 'Mandate', dealStatus: 'intake' },
            { index: 2, name: 'Marketing', dealStatus: 'active' },
            { index: 3, name: 'Diligence', dealStatus: 'active' },
          ],
          steps: [
            step({ id: 's1', phaseIndex: 1, status: 'complete' }),
            step({ id: 's2', phaseIndex: 3, status: 'current' }),
          ],
        })}
      />,
    );
    expect(screen.getByRole('img', { name: 'Phase: Diligence' })).toBeInTheDocument();
    expect(screen.getByText('Diligence')).toBeInTheDocument();
    expect(screen.queryByText(/ of 2/)).not.toBeInTheDocument();
  });

  it('names the current phase in its aria-label, with no number', () => {
    render(
      <PhaseMeter
        rail={rail({
          currentStepId: 's2',
          steps: [
            step({ id: 's1', phaseIndex: 1, status: 'complete' }),
            step({ id: 's2', phaseIndex: 2, status: 'current' }),
          ],
        })}
      />,
    );
    expect(screen.getByRole('img', { name: 'Phase: Marketing' })).toBeInTheDocument();
  });

  it('excludes a removed-only phase from the count it renders', () => {
    render(
      <PhaseMeter
        rail={rail({
          currentStepId: 's1',
          steps: [
            step({ id: 's1', phaseIndex: 1, status: 'current' }),
            step({ id: 's2', phaseIndex: 2, removedAt: '2026-09-09T10:00:00Z' }),
          ],
        })}
      />,
    );
    expect(screen.getByRole('img', { name: /^Phase: / })).toBeInTheDocument();
    expect(screen.getAllByRole('img')[0].children).toHaveLength(1);
  });

  it('renders a null current step as no active phase, never as completion', () => {
    render(
      <PhaseMeter
        rail={rail({
          currentStepId: null,
          steps: [step({ id: 's1', phaseIndex: 1, status: 'complete' })],
        })}
      />,
    );
    expect(screen.getByRole('img', { name: 'No active phase' })).toBeInTheDocument();
  });

  it('captions the phase name only when withCaption is set', () => {
    const withCursor = rail({
      currentStepId: 's2',
      steps: [
        step({ id: 's1', phaseIndex: 1, status: 'complete' }),
        step({ id: 's2', phaseIndex: 2, status: 'current' }),
      ],
    });
    render(<PhaseMeter rail={withCursor} />);
    expect(screen.queryByText(/Marketing/)).not.toBeInTheDocument();
    cleanup();
    render(<PhaseMeter rail={withCursor} withCaption />);
    expect(screen.getByText('Marketing')).toBeInTheDocument();
  });
});

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'project-summit' }),
  usePathname: () => '/projects/project-summit',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({ state: { status: 'loading', email: null } }),
}));

const FLAGS_OFF: FlagMap = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: false,
  platform_onboarding: false,
  work_identity_onboarding: false,
  mail_channel: false,
  mail_jev_second_opinion: false,
  teaser_sandbox_runner: false,
  company_access_management: false,
  setup_walkthroughs: false,
  book_view: false,
  project_rail_model: false,
  deal_discovery: false,
  discovery_worker_enabled: false,
  discovery_model_proposals_demo: false,
  skill_authoring: false,
  workbench_top_nav: false,
  skill_output_revisions: false,
};

describe('DealContextBar reachable through the real component chain', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the phase meter from the catalog-fallback rail with the flag off', async () => {
    const { DealContextBar } = await import('@/components/shell/DealContextBar');
    render(
      <FlagsProvider value={FLAGS_OFF}>
        <DealContextBar />
      </FlagsProvider>,
    );
    const meter = await screen.findByRole('img', { name: /^Phase: / });
    expect(meter).toBeInTheDocument();
  });

  it('names the deal by code name only; the deal code waits inside the switcher menu', async () => {
    const { DealContextBar } = await import('@/components/shell/DealContextBar');
    render(
      <FlagsProvider value={FLAGS_OFF}>
        <DealContextBar />
      </FlagsProvider>,
    );
    const DEAL_CODE = /[A-Z]{3,}-\d{4}-\d{3}/;
    const switcher = await screen.findByRole('button', { name: /^Deal: .+\. Switch deal$/ });
    expect(switcher.textContent).not.toMatch(DEAL_CODE);
    fireEvent.click(switcher);
    const menu = screen.getByRole('dialog', { name: 'Switch deal' });
    expect(menu.textContent).toMatch(DEAL_CODE);
  });
});

describe('ProjectDashboard reachable through the real component chain', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.doMock('next/navigation', () => ({
      useParams: () => ({ projectId: SEED_DEALS[0].id }),
      usePathname: () => `/projects/${SEED_DEALS[0].id}`,
      useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    }));
  });

  it('shows the phase caption for the fixture deal with the flag off', async () => {
    vi.resetModules();
    const { ProjectDashboard } = await import('@/components/workspace/ProjectDashboard');
    render(
      <FlagsProvider value={FLAGS_OFF}>
        <ProjectDashboard />
      </FlagsProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByText(/Loading dashboard/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('img', { name: /^Phase: / })).toBeInTheDocument();
  });
});
