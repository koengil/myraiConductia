import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import * as React from 'react';

import { TeamRoster } from '../src/components/team/TeamRoster';
import { DealHome } from '../src/components/workspace/DealHome';
import { ProjectDashboard } from '../src/components/workspace/ProjectDashboard';
import { useResolvedDeal } from '../src/lib/deals/useDeals';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import type { FlagMap } from '../src/lib/flags/resolveFlags';
import { SEED_DEALS, createDeal, resolveDeal } from '../src/lib/rail/deals';
import { RAIL_LOAD_DEADLINE_MS } from '../src/lib/rail/railLoadStage';

/*
 * Deal identity — every surface names the deal that is actually open.
 *
 * Real navigation puts the deal CODE in the /projects/[projectId] segment
 * (ATLAS-2026-001), the demo puts the fixture slug (project-summit). Both must
 * resolve, and an id that matches neither must not resolve to some other real
 * deal: a screen that names the wrong deal is a wall-crossing hazard.
 */

let projectId = 'project-summit';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId }),
  usePathname: () => `/projects/${projectId}`,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

beforeEach(() => {
  window.localStorage.clear();
  projectId = 'project-summit';
});

afterEach(() => cleanup());

describe('resolveDeal', () => {
  it('resolves a seeded deal by its fixture slug', () => {
    expect(resolveDeal('project-harbor')?.code).toBe(SEED_DEALS[1].code);
  });

  it('resolves a seeded deal by its deal code', () => {
    expect(resolveDeal(SEED_DEALS[1].code)?.id).toBe('project-harbor');
  });

  it('resolves a created deal by its deal code', () => {
    const created = createDeal(
      { id: 'northwind', name: 'Northwind', sector: 'Logistics' },
      'Project Atlas',
    );
    expect(resolveDeal(created.code)?.codename).toBe('Project Atlas');
  });

  it('returns null for an unknown id rather than another deal', () => {
    expect(resolveDeal('not-a-uuid')).toBeNull();
    expect(resolveDeal('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(resolveDeal('ATLAS-2026-001')).toBeNull();
  });
});

describe('Team roster identity', () => {
  it('opens the deal the code segment points at, and leaves its name to the deal switcher', () => {
    projectId = SEED_DEALS[1].code;
    render(<TeamRoster />);
    expect(screen.getByRole('heading', { level: 1, name: 'Team' })).toBeInTheDocument();
    // The switcher already names the deal: the header never repeats it, and has no "Team" eyebrow.
    expect(screen.queryByText(SEED_DEALS[1].codename, { exact: false })).toBeNull();
    expect(screen.queryByText(/^Team · /)).toBeNull();
    expect(screen.getAllByText('Team')).toHaveLength(1);
  });

  it('reports an unknown deal instead of naming a different one', () => {
    projectId = 'not-a-uuid';
    render(<TeamRoster />);
    expect(screen.getByRole('status')).toHaveTextContent('You are not on this deal.');
    expect(screen.queryByText(SEED_DEALS[0].codename, { exact: false })).toBeNull();
    // The page's one h1, as on the roster itself (S6R5-R1 M2).
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('Team');
  });
});

const PLATFORM_DEALS = [
  { code: 'ATLAS-2026-001', codename: 'Project Atlas' },
  { code: 'NW-2026-002', codename: 'Project Northwind' },
  { code: 'SUMMIT-2026-003', codename: 'Project Summit' },
  { code: 'E2E5F-2026-545', codename: 'Project Foxglove' },
  { code: 'E2EHZ-2026-747', codename: 'Project Hazel' },
];

const FLAGS: FlagMap = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: true,
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
  workbench_top_nav: false,
  skill_authoring: false,
  skill_output_revisions: false,
};

function stubPlatformDeals() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/v1/deals')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            deals: PLATFORM_DEALS.map((d, i) => ({
              id: `uuid-${i}`,
              code: d.code,
              codename: d.codename,
              status: 'active',
              createdAt: '2026-08-01T00:00:00Z',
              entryStepSeq: 1,
              currentStepSeq: 1,
              targetName: null,
              dealRole: 'md',
              conflictsApprovedBy: null,
              conflictsApprovedOn: null,
            })),
          }),
      } as unknown as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function flagsWrapper({ children }: { children: React.ReactNode }) {
  return <FlagsProvider value={FLAGS}>{children}</FlagsProvider>;
}

describe('deals that live in the platform list, not the fixture store', () => {
  beforeEach(() => stubPlatformDeals());
  afterEach(() => vi.unstubAllGlobals());

  it('resolves every real deal code to its own identity', async () => {
    for (const expected of PLATFORM_DEALS) {
      const { result, unmount } = renderHook(() => useResolvedDeal(expected.code), {
        wrapper: flagsWrapper,
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));
      expect(result.current).toEqual({
        status: 'ready',
        deal: expect.objectContaining({ code: expected.code, codename: expected.codename }),
      });
      unmount();
    }
  });

  it('keeps the database Summit distinct from the fixture Summit', async () => {
    const { result } = renderHook(() => useResolvedDeal('SUMMIT-2026-003'), {
      wrapper: flagsWrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.status === 'ready' && result.current.deal.code).toBe('SUMMIT-2026-003');
    expect(result.current.status === 'ready' && result.current.deal.code).not.toBe(
      SEED_DEALS[0].code,
    );
  });

  it('still resolves a fixture deal the platform list does not carry', async () => {
    const { result } = renderHook(() => useResolvedDeal(SEED_DEALS[1].id), {
      wrapper: flagsWrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.status === 'ready' && result.current.deal.codename).toBe(
      SEED_DEALS[1].codename,
    );
  });

  it('reads as unknown only when neither source carries the id', async () => {
    const { result } = renderHook(() => useResolvedDeal('not-a-uuid'), {
      wrapper: flagsWrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('unknown'));
  });

  it('the deal home for a deal not in the viewer\'s list is the shared not-on-deal state', async () => {
    projectId = 'not-a-uuid';
    render(
      <FlagsProvider value={FLAGS}>
        <ProjectDashboard />
      </FlagsProvider>,
    );
    expect(await screen.findByText('You are not on this deal.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Conductor Center' })).toHaveAttribute('href', '/projects');
    expect(screen.queryByText(/could not be found/)).toBeNull();
  });

  it('renders the dashboard for a real deal under its own name', async () => {
    projectId = 'ATLAS-2026-001';
    render(
      <FlagsProvider value={FLAGS}>
        <ProjectDashboard />
      </FlagsProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Project Atlas' })).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).toBeNull();
    expect(screen.queryByText(SEED_DEALS[0].code)).toBeNull();
    // The name once, no code subtitle, no centered hero.
    expect(screen.getAllByText('Project Atlas')).toHaveLength(1);
    expect(screen.queryByText('Dashboard')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Project Atlas' }).className).not.toMatch(/text-center/);
  });

  it('opens a real deal\'s Team without repeating its name in the header', async () => {
    projectId = 'NW-2026-002';
    render(
      <FlagsProvider value={FLAGS}>
        <TeamRoster />
      </FlagsProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Team' })).toBeInTheDocument();
    expect(screen.queryByText(/Project Northwind/)).toBeNull();
  });
});

describe('a failed deal list is never "not found" (#162)', () => {
  const P1: FlagMap = { ...FLAGS, platform_onboarding: true };

  afterEach(async () => {
    const { abortAllReads } = await import('../src/lib/api/inflightRead');
    abortAllReads();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function failingDeals(status = 500) {
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: false,
        status: String(input).startsWith('/api/v1/deals') ? status : 404,
        json: () => Promise.resolve({}),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function dealsCalls(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/v1/deals').length;
  }

  it('the dashboard states the list error with Try again, for a seed fixture segment too', async () => {
    const fetchMock = failingDeals();
    projectId = 'project-summit';
    render(
      <FlagsProvider value={P1}>
        <ProjectDashboard />
      </FlagsProvider>,
    );
    expect(
      await screen.findByText('Your deal list could not be loaded right now.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).toBeNull();
    expect(screen.queryByText(SEED_DEALS[0].codename)).toBeNull();

    const before = dealsCalls(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(dealsCalls(fetchMock)).toBe(before + 1));
  });

  it('the deal home states the list error, not "not found"', async () => {
    failingDeals();
    projectId = 'ATLAS-2026-001';
    render(
      <FlagsProvider value={P1}>
        <DealHome />
      </FlagsProvider>,
    );
    expect(
      await screen.findByText('Your deal list could not be loaded right now.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).toBeNull();
  });

  it('the fixture Team roster states a timed-out list, not "not found"', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    projectId = 'not-a-uuid';
    render(
      <FlagsProvider value={FLAGS}>
        <TeamRoster />
      </FlagsProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RAIL_LOAD_DEADLINE_MS);
    });
    expect(screen.getByText('Your deal list could not be loaded right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('You are not on this deal.')).toBeNull();
  });
});

// S6R5-06: a not-on-deal page still has exactly one h1, the deal-less page
// title, since the state replaces the whole page.
describe('the deal home for a deal the viewer is not on', () => {
  it.each([
    ['DealHome', DealHome],
    ['ProjectDashboard', ProjectDashboard],
  ])('%s has one h1, the page title', async (_name, Component) => {
    projectId = 'not-a-uuid';
    render(<Component />);
    expect(await screen.findByText('You are not on this deal.')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Dashboard');
  });
});
