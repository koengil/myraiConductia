import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { DealRail } from '@/components/rail/DealRail';
import { Sidebar } from '@/components/organisms/navigation/Sidebar';
import { TopBar } from '@/components/organisms/navigation/TopBar';
import { TopNav } from '@/components/organisms/navigation';
import { abortAllReads } from '@/lib/api/inflightRead';
import { RAIL_LOAD_DEADLINE_MS } from '@/lib/rail/railLoadStage';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import { SessionProvider } from '@/lib/session/store';

/*
 * #162: every deal-list and rail consumer mounted in one wave joins one
 * in-flight read per URL, so a cold rail board load makes one GET
 * /api/v1/deals and one GET …/rail, not one per consumer on the Sidebar,
 * TopBar and TopNav shell (Chromium's HTTP cache lock would release identical
 * reads one at a time). This pins the fan-out with the real shell and rail mounted
 * together and the two gating reads held open.
 */

const DEAL = 'MESAX-2026-462';
const DEALS_URL = '/api/v1/deals';
const RAIL_URL = `/api/v1/deals/${DEAL}/rail`;

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: DEAL }),
  usePathname: () => `/projects/${DEAL}/rail`,
  useSearchParams: () => new URLSearchParams(search),
}));

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { email: 'book-md@bank.test' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

vi.mock('@/components/wizard/NewMandateDialog', () => ({ NewMandateDialog: () => null }));

const ME = {
  user: {
    id: 'user-1',
    email: 'book-md@bank.test',
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

const API_DEAL = {
  id: 'uuid-mesa',
  code: DEAL,
  codename: 'Project Mesa',
  status: 'active',
  createdAt: '2026-07-15T00:00:00Z',
  entryStepSeq: 12,
  currentStepSeq: 12,
  targetName: null,
  dealRole: 'md',
  conflictsApprovedBy: null,
  conflictsApprovedOn: null,
};

function serverRail() {
  const steps = orderedSteps(MVP_DEAL_RAIL).slice(0, 3);
  return {
    currentStepId: 'uuid-0',
    canEditStructure: false,
    canSaveTemplate: false,
    phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
    steps: steps.map((step, i) => ({
      id: `uuid-${i}`,
      stepId: step.id,
      origin: 'catalog',
      phaseIndex: phaseForStep(step.id, MVP_DEAL_RAIL)?.index ?? 1,
      displayOrder: i + 1,
      seq: step.seq,
      status: i === 0 ? 'current' : 'pending',
      definition: null,
      anchorStepId: null,
      removedAt: null,
      removedBy: null,
      skip: null,
    })),
  };
}

function flags(topNav: boolean): FlagMap {
  const map = Object.fromEntries(
    (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, false]),
  ) as FlagMap;
  return {
    ...map,
    gate0_api_create: true,
    platform_onboarding: true,
    project_rail_model: true,
    workbench_top_nav: topNav,
  };
}

type Held = { url: string; resolve: (body: unknown) => void; settled: boolean };
let held: Held[];
let fetchMock: ReturnType<typeof vi.fn>;
let stepRecordsCalls: number;

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  search = '';
  held = [];
  window.localStorage.clear();
  stepRecordsCalls = 0;
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === DEALS_URL || url === RAIL_URL) {
      // Held open until the test answers it. Like a real fetch, it rejects
      // when its signal aborts (the deadline, or an identity change).
      return new Promise<Response>((resolve, reject) => {
        const entry: Held = {
          url,
          settled: false,
          resolve: (body) => {
            entry.settled = true;
            resolve(json(body));
          },
        };
        init?.signal?.addEventListener('abort', () => {
          entry.settled = true;
          reject(init.signal!.reason);
        });
        held.push(entry);
      });
    }
    if (url.startsWith('/api/v1/me')) return Promise.resolve(json(ME));
    if (url.endsWith('/step-records')) {
      stepRecordsCalls += 1;
      return Promise.resolve(json({ records: [] }));
    }
    if (url.startsWith('/api/v1/notifications')) return Promise.resolve(json({ notifications: [] }));
    if (url.startsWith('/api/v1/access-requests')) return Promise.resolve(json({ requests: [] }));
    return Promise.resolve(json({ error: 'Not found' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  abortAllReads();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function calls(url: string): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === url).length;
}

function renderSidebarShell() {
  return render(
    <FlagsProvider value={flags(false)}>
      <SessionProvider>
        <Sidebar collapsed={false} onToggle={() => {}} />
        <TopBar inProject />
        <DealRail />
      </SessionProvider>
    </FlagsProvider>,
  );
}

function renderTopNavShell() {
  return render(
    <FlagsProvider value={flags(true)}>
      <SessionProvider>
        <TopNav />
        <DealRail />
      </SessionProvider>
    </FlagsProvider>,
  );
}

async function openTheGate() {
  // Wave 1 is fully issued: every mount effect has run. The gate names the
  // dependency it waits for (Phase 3).
  await act(async () => {});
  expect(screen.getByText('Loading your deal list…')).toBeInTheDocument();
  expect(calls(DEALS_URL)).toBe(1);
  expect(calls(RAIL_URL)).toBe(1);

  await answer(DEALS_URL);
  expect(screen.getByText('Loading the deal rail…')).toBeInTheDocument();
  expect(screen.queryByText('Loading your deal list…')).not.toBeInTheDocument();
  await answer(RAIL_URL);
}

/** Answer every still-open held read for `url`. */
async function answer(url: string) {
  await act(async () => {
    for (const h of held) {
      if (h.url !== url || h.settled) continue;
      h.resolve(url === DEALS_URL ? { deals: [API_DEAL] } : serverRail());
    }
  });
}

async function pastTheDeadline() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RAIL_LOAD_DEADLINE_MS);
  });
}

/** The rail's own Try again (the chrome's carry a longer accessible name). */
function railTryAgain(): HTMLElement {
  return screen.getByRole('button', { name: 'Try again' });
}

describe('rail cold load fan-out (#162)', () => {
  it('Sidebar + TopBar, board: one /deals and one /rail, then ready', async () => {
    renderSidebarShell();
    await openTheGate();

    expect(await screen.findByLabelText('Rail overview')).toBeInTheDocument();
    expect(screen.queryByText('Loading the deal rail…')).not.toBeInTheDocument();
    // The shell got the same list: the deal identity shows in the TopBar.
    expect(screen.getAllByText('Project Mesa').length).toBeGreaterThan(0);
    expect(calls(DEALS_URL)).toBe(1);
    expect(calls(RAIL_URL)).toBe(1);
  });

  it('Sidebar + TopBar, zoomed in by ?step=: the same one /deals and one /rail before the gate, then ready', async () => {
    search = `step=${orderedSteps(MVP_DEAL_RAIL)[1].seq}`;
    renderSidebarShell();
    await openTheGate();

    expect(await screen.findByLabelText('Step detail')).toBeInTheDocument();
    expect(calls(RAIL_URL)).toBe(1);
  });

  it('TopNav, board: one /deals and one /rail, then ready', async () => {
    renderTopNavShell();
    await openTheGate();

    expect(await screen.findByLabelText('Rail overview')).toBeInTheDocument();
    expect(calls(DEALS_URL)).toBe(1);
    expect(calls(RAIL_URL)).toBe(1);
  });

  it('the deal list past its deadline: the rail says so, the shell says so, and Try again recovers all of them with one /deals and one /rail', async () => {
    vi.useFakeTimers();
    renderSidebarShell();
    await act(async () => {});
    await answer(RAIL_URL);
    expect(screen.getByText('Loading your deal list…')).toBeInTheDocument();

    await pastTheDeadline();
    expect(screen.getByText('Your deal list could not be loaded right now.')).toBeInTheDocument();
    // Never "not found", never a fixture or the catalog rail in its place.
    expect(screen.queryByLabelText('Rail overview')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be found/)).not.toBeInTheDocument();
    // The shell states it too: the Sidebar list slot and the TopBar identity.
    expect(screen.getAllByText('Deals unavailable.')).toHaveLength(2);
    expect(screen.queryByText('Project Mesa')).not.toBeInTheDocument();

    const deals = calls(DEALS_URL);
    const rail = calls(RAIL_URL);
    act(() => railTryAgain().click());
    // Same act: every stale state presents as loading, so no live Try again
    // (and no error) remains during the refetch.
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Your deal list could not be loaded right now.')).not.toBeInTheDocument();
    expect(screen.queryByText('Deals unavailable.')).not.toBeInTheDocument();
    expect(screen.getByText('Loading your deal list…')).toBeInTheDocument();

    await act(async () => {});
    expect(calls(DEALS_URL)).toBe(deals + 1);
    expect(calls(RAIL_URL)).toBe(rail + 1);

    await answer(DEALS_URL);
    await answer(RAIL_URL);
    expect(screen.getByLabelText('Rail overview')).toBeInTheDocument();
    // The deal identity and the shell recover from the same fresh read.
    expect(screen.getAllByText('Project Mesa').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Deals unavailable.')).not.toBeInTheDocument();
    expect(calls(DEALS_URL)).toBe(deals + 1);
    expect(calls(RAIL_URL)).toBe(rail + 1);
  });

  it('the rail past its deadline: the rail error with Try again; Try again refetches step records exactly once', async () => {
    vi.useFakeTimers();
    renderSidebarShell();
    await act(async () => {});
    await answer(DEALS_URL);
    // Step records loaded first (they wait on the deal list, not the rail).
    expect(stepRecordsCalls).toBe(1);
    expect(screen.getByText('Loading the deal rail…')).toBeInTheDocument();

    await pastTheDeadline();
    expect(screen.getByText('The deal rail could not be loaded right now.')).toBeInTheDocument();
    expect(screen.queryByText('Your deal list could not be loaded right now.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Rail overview')).not.toBeInTheDocument();

    const deals = calls(DEALS_URL);
    const rail = calls(RAIL_URL);
    act(() => railTryAgain().click());
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('The deal rail could not be loaded right now.')).not.toBeInTheDocument();

    await act(async () => {});
    expect(calls(DEALS_URL)).toBe(deals + 1);
    expect(calls(RAIL_URL)).toBe(rail + 1);
    await answer(DEALS_URL);
    await answer(RAIL_URL);

    expect(screen.getByLabelText('Rail overview')).toBeInTheDocument();
    expect(screen.getAllByText('Project Mesa').length).toBeGreaterThanOrEqual(2);
    expect(stepRecordsCalls).toBe(2);
    expect(calls(DEALS_URL)).toBe(deals + 1);
    expect(calls(RAIL_URL)).toBe(rail + 1);
  });

  it('both reads past their deadline: one Try again from the Sidebar refreshes the deal list AND this rail, and the rail recovers', async () => {
    vi.useFakeTimers();
    renderSidebarShell();
    await act(async () => {});
    expect(calls(DEALS_URL)).toBe(1);
    expect(calls(RAIL_URL)).toBe(1);

    await pastTheDeadline();
    expect(screen.getByText('Your deal list could not be loaded right now.')).toBeInTheDocument();
    // Step records wait on the deal list, which never answered.
    expect(stepRecordsCalls).toBe(0);

    const deals = calls(DEALS_URL);
    const rail = calls(RAIL_URL);
    const sidebar = screen.getByRole('navigation', { name: 'Primary navigation' });
    act(() => within(sidebar).getByRole('button', { name: /Try again/ }).click());
    expect(screen.queryByRole('button', { name: /Try again/ })).not.toBeInTheDocument();

    await act(async () => {});
    expect(calls(DEALS_URL)).toBe(deals + 1);
    expect(calls(RAIL_URL)).toBe(rail + 1);

    await answer(DEALS_URL);
    await answer(RAIL_URL);
    // The rail never lands on its own error: its read was refreshed too.
    expect(screen.queryByText('The deal rail could not be loaded right now.')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Rail overview')).toBeInTheDocument();
    expect(screen.queryByText('Deals unavailable.')).not.toBeInTheDocument();
    // Exactly one step-records read, once the deal list and the rail recover.
    expect(stepRecordsCalls).toBe(1);
    expect(calls(DEALS_URL)).toBe(deals + 1);
    expect(calls(RAIL_URL)).toBe(rail + 1);
  });
});
