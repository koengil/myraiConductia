import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { DealRail } from '@/components/rail/DealRail';
import { abortAllReads } from '@/lib/api/inflightRead';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { DEAL_RAIL, MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { DealStepRecord } from '@/lib/rail/dealStepRecord';
import { SessionProvider } from '@/lib/session/store';

/*
 * 8b (a) on the rail, real-deal path: owners on every open card from one
 * step-records read, the last activity from one audit read, "Done by" on an
 * out-of-order completion, "Current step" for the cursor, the personal views,
 * the MD's deliberate "Assign…", and the focus refresh. No read per card.
 */

const DEAL = 'SUMMIT-2026-003';
const catalog = orderedSteps(DEAL_RAIL);
const bySeq = (seq: number) => catalog.find((s) => s.seq === seq)!;
const title = (seq: number) => bySeq(seq).title;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ projectId: DEAL }),
  usePathname: () => `/projects/${DEAL}/rail`,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { email: 'storm@bank.test' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

const ME = {
  user: {
    id: 'u-storm',
    email: 'storm@bank.test',
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

let dealRole = 'md';
const apiDeal = () => ({
  id: 'uuid-summit',
  code: DEAL,
  codename: 'Project Summit',
  status: 'active',
  createdAt: '2026-07-15T00:00:00Z',
  entryStepSeq: 12,
  currentStepSeq: 12,
  targetName: null,
  dealRole,
  conflictsApprovedBy: null,
  conflictsApprovedOn: null,
});

const SEQS = [12, 13, 14, 15, 16, 17];
function serverRail() {
  return {
    currentStepId: 'uuid-12',
    canEditStructure: false,
    canSaveTemplate: false,
    phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
    steps: SEQS.map((seq, i) => ({
      id: `uuid-${seq}`,
      stepId: bySeq(seq).id,
      origin: 'catalog',
      phaseIndex: phaseForStep(bySeq(seq).id, MVP_DEAL_RAIL)?.index ?? 1,
      displayOrder: i + 1,
      seq,
      status: seq === 12 ? 'current' : seq === 13 ? 'complete' : 'pending',
      definition: null,
      anchorStepId: null,
      removedAt: null,
      removedBy: null,
      skip: null,
    })),
  };
}

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function rec(seq: number, status: string, extra: Partial<DealStepRecord> = {}): DealStepRecord {
  return {
    stepId: bySeq(seq).id,
    seq,
    status,
    assignedTo: null,
    assignedToName: null,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    completionNote: null,
    skip: null,
    ...extra,
  };
}

let records: DealStepRecord[];
let events: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function flags(): FlagMap {
  const map = Object.fromEntries((Object.keys(FLAG_REGISTRY) as FlagKey[]).map((k) => [k, false])) as FlagMap;
  return { ...map, gate0_api_create: true, platform_onboarding: true, project_rail_model: true };
}

beforeEach(() => {
  dealRole = 'md';
  window.localStorage.clear();
  records = [
    rec(12, 'current', { assignedTo: 'u-alex', assignedToName: 'Alex Chen' }),
    rec(13, 'complete', {
      assignedTo: 'u-morgan',
      assignedToName: 'Morgan Vale',
      completedBy: 'u-morgan',
      completedByName: 'Morgan Vale',
      completedAt: ago(1),
    }),
    rec(14, 'pending'),
    rec(15, 'pending', { assignedTo: 'u-storm', assignedToName: 'Storm Duncan' }),
    rec(16, 'pending'),
    rec(17, 'pending', { assignedTo: 'u-morgan', assignedToName: 'Morgan Vale' }),
  ];
  events = [
    { ts: ago(1), action: 'complete_step', detail: { stepId: bySeq(13).id }, actor: { display_name: 'Morgan Vale' } },
    { ts: ago(2), action: 'step_work', detail: { stepId: bySeq(12).id }, actor: { display_name: 'Alex Chen' } },
    { ts: ago(3), action: 'assign_step', detail: { stepId: bySeq(15).id }, actor: { display_name: 'Storm Duncan' } },
    { ts: ago(3), action: 'assign_step', detail: { stepId: bySeq(12).id }, actor: { display_name: 'Storm Duncan' } },
  ];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v1/deals') return json({ deals: [apiDeal()] });
    if (url === `/api/v1/deals/${DEAL}/rail`) return json(serverRail());
    if (url.endsWith('/step-records')) return json({ records });
    if (url.endsWith('/audit')) return json({ deal: {}, events });
    if (url.includes('/steps/') && (init?.method ?? 'GET') === 'GET') {
      return json({
        step: { assignedTo: null, status: records.find((r) => url.endsWith(`/steps/${r.stepId}`))?.status },
        members: [
          { id: 'u-storm', name: 'Storm Duncan', dealRole: 'md' },
          { id: 'u-alex', name: 'Alex Chen', dealRole: 'deal_team' },
        ],
        permissions: { canAssign: dealRole === 'md' },
      });
    }
    if (url.includes('/steps/') && init?.method === 'PATCH') return json({ step: {} });
    if (url.startsWith('/api/v1/me')) return json(ME);
    return json({ error: 'Not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  abortAllReads();
  vi.unstubAllGlobals();
});

function calls(match: (url: string, init?: RequestInit) => boolean): number {
  return fetchMock.mock.calls.filter(([input, init]) => match(String(input), init as RequestInit | undefined)).length;
}

async function renderRail() {
  render(
    <FlagsProvider value={flags()}>
      <SessionProvider>
        <DealRail />
      </SessionProvider>
    </FlagsProvider>,
  );
  const board = await screen.findByRole('region', { name: 'Rail overview' });
  await screen.findByText(/Draft saved by Alex Chen/);
  return board;
}

const card = (seq: number) => screen.getByTestId(`step-uuid-${seq}`);

/** Zooms into a step: Assign… lives in its detail. */
async function openStep(seq: number) {
  fireEvent.click(within(card(seq)).getByRole('button', { name: /^Step \d+ · / }));
  return screen.findByRole('region', { name: 'Step detail' });
}

function applyViews(...labels: string[]) {
  fireEvent.click(screen.getByRole('button', { name: /^Show:/ }));
  const panel = screen.getByRole('dialog', { name: 'Show' });
  fireEvent.click(within(panel).getByRole('checkbox', { name: /^All/ }));
  for (const label of labels) {
    fireEvent.click(within(panel).getByRole('checkbox', { name: new RegExp(`^${label}`) }));
  }
  fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
}

describe('rail multiplayer on real data', () => {
  it('names the owner on every open card, the last activity, and Done on an out-of-order step', async () => {
    await renderRail();
    expect(within(card(12)).getByText('Alex Chen')).toBeInTheDocument();
    expect(within(card(12)).getByText('Draft saved by Alex Chen · 2h ago')).toBeInTheDocument();
    expect(within(card(12)).getByText('Current step')).toBeInTheDocument();
    expect(within(card(14)).getByText('Unassigned')).toBeInTheDocument();
    expect(within(card(15)).getByText('Assigned by Storm Duncan · 3h ago')).toBeInTheDocument();
    // Step 13 is done while step 12, before it, is still the current step.
    expect(card(13)).toHaveAttribute('data-state', 'done');
    expect(within(card(13)).getByText('Done by Morgan Vale · 1h ago')).toBeInTheDocument();
    expect(card(12)).toHaveAttribute('data-state', 'active');
    expect(screen.queryByText(/In progress/)).not.toBeInTheDocument();
  });

  it('reads owners and activity once for the rail, never per card', async () => {
    await renderRail();
    expect(calls((u) => u.endsWith('/step-records'))).toBe(1);
    expect(calls((u) => u.endsWith('/audit'))).toBe(1);
    expect(calls((u) => u.includes('/steps/'))).toBe(0);
  });

  it('filters to Open, Mine, Unassigned and Has activity, and remembers it here', async () => {
    const board = await renderRail();
    const stack = () => within(board).getByRole('list', { name: 'Origination steps' });
    const shown = () => within(stack()).queryAllByRole('button', { name: /^Step \d+ · / }).map((b) => b.getAttribute('aria-label'));

    applyViews('Open');
    expect(shown()).toEqual(expect.arrayContaining([expect.stringContaining(title(14))]));
    expect(shown()).not.toEqual(expect.arrayContaining([expect.stringContaining(title(13))]));

    applyViews('Mine');
    expect(shown()).toEqual([expect.stringContaining(title(15))]);
    expect(window.localStorage.getItem('conductia.pref.railViewFilter')).toBe('mine');

    applyViews('Unassigned');
    expect(shown()).toEqual([expect.stringContaining(title(14)), expect.stringContaining(title(16))]);

    applyViews('Has activity');
    expect(shown()).toEqual([
      expect.stringContaining(title(12)),
      expect.stringContaining(title(13)),
      expect.stringContaining(title(15)),
    ]);

    cleanup();
    abortAllReads();
    await renderRail();
    expect(screen.getByRole('button', { name: /^Show: Has activity/ })).toBeInTheDocument();
  });

  it('shows steps from any view ticked together, and keeps them here', async () => {
    const board = await renderRail();
    const stack = () => within(board).getByRole('list', { name: 'Origination steps' });
    const shown = () => within(stack()).queryAllByRole('button', { name: /^Step \d+ · / }).map((b) => b.getAttribute('aria-label'));

    applyViews('Mine', 'Unassigned');
    expect(shown()).toEqual([
      expect.stringContaining(title(14)),
      expect.stringContaining(title(15)),
      expect.stringContaining(title(16)),
    ]);
    expect(screen.getByRole('button', { name: /^Show: 2 views/ })).toBeInTheDocument();
    expect(window.localStorage.getItem('conductia.pref.railViewFilter')).toBe('mine,unassigned');
  });

  it('finds a step by name or number, and says how many match', async () => {
    const board = await renderRail();
    const stack = () => within(board).getByRole('list', { name: 'Origination steps' });
    const search = screen.getByRole('searchbox', { name: 'Search steps' });

    fireEvent.change(search, { target: { value: title(14) } });
    expect(within(stack()).queryAllByRole('button', { name: /^Step \d+ · / })).toHaveLength(1);
    expect(screen.getByText('1 step matches.')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'no step is called this' } });
    expect(screen.getByText('No steps match.')).toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(screen.queryByText('No steps match.')).not.toBeInTheDocument();
  });

  it('turns a phase header count into that view, and back to All', async () => {
    const board = await renderRail();
    const link = within(board).getAllByRole('button', { name: /^\d+ unassigned$/ })[0];
    fireEvent.click(link);
    expect(screen.getByRole('button', { name: /^Show: Unassigned/ })).toBeInTheDocument();
    fireEvent.click(within(board).getAllByRole('button', { name: /^\d+ unassigned$/ })[0]);
    expect(screen.getByRole('button', { name: /^Show: All/ })).toBeInTheDocument();
  });

  it('lets the MD assign deliberately from step detail: choice, what happens, then the existing PATCH', async () => {
    await renderRail();
    const detail = await openStep(14);
    fireEvent.click(await within(detail).findByRole('button', { name: 'Assign…' }));

    const dialog = await screen.findByRole('dialog', { name: title(14) });
    fireEvent.click(await within(dialog).findByRole('radio', { name: /Alex Chen/ }));
    expect(within(dialog).getByText('Alex Chen gets a notification that this step is theirs.')).toBeInTheDocument();
    expect(calls((_u, init) => init?.method === 'PATCH')).toBe(0);

    const before = calls((u) => u.endsWith('/step-records'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign to Alex Chen' }));
    await waitFor(() => expect(calls((_u, init) => init?.method === 'PATCH')).toBe(1));
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')!;
    expect(String(patch[0])).toBe(`/api/v1/deals/${DEAL}/steps/${bySeq(14).id}`);
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ assignTo: 'u-alex' });
    await waitFor(() => expect(calls((u) => u.endsWith('/step-records'))).toBeGreaterThan(before));
  });

  it('offers no Assign… on a closed step', async () => {
    await renderRail();
    const detail = await openStep(13);
    // The owner line reads first, so the check below runs against the loaded control.
    await within(detail).findByText(/Unassigned|Assigned to/);
    expect(within(detail).queryByRole('button', { name: 'Assign…' })).not.toBeInTheDocument();
  });

  it('shows no Assign… to anyone but the deal MD, who still reads the owner', async () => {
    dealRole = 'deal_team';
    await renderRail();
    expect(within(card(14)).queryByRole('button', { name: /^Add a step after/ })).toBeNull();
    const detail = await openStep(14);
    await waitFor(() => expect(calls((u) => u.includes('/steps/'))).toBeGreaterThan(0));
    await act(async () => {});
    expect(within(detail).queryByRole('button', { name: 'Assign…' })).not.toBeInTheDocument();
  });

  it('picks up a teammate\'s draft and completion when the tab regains focus', async () => {
    await renderRail();
    expect(card(14)).toHaveAttribute('data-state', 'todo');
    records = records.map((r) =>
      r.seq === 14
        ? { ...r, status: 'complete', completedBy: 'u-alex', completedByName: 'Alex Chen', completedAt: ago(0) }
        : r,
    );
    events = [
      { ts: ago(0), action: 'step_work', detail: { stepId: bySeq(16).id }, actor: { display_name: 'Alex Chen' } },
      ...events,
    ];
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(within(card(16)).getByText('Draft saved by Alex Chen · just now')).toBeInTheDocument());
    expect(card(14)).toHaveAttribute('data-state', 'done');
    expect(within(card(14)).getByText(/^Done by Alex Chen/)).toBeInTheDocument();
    // The rail itself is not re-read (no loading flash): only owners and activity.
    expect(calls((u) => u === `/api/v1/deals/${DEAL}/rail`)).toBe(1);
  });
});

describe('RB review follow-ups', () => {
  it('drops "Assigned by" once the owner is removed: the card reads Unassigned alone and has no activity', async () => {
    events = [
      { ts: ago(0.5), action: 'assign_step', detail: { stepId: bySeq(14).id, assignee: 'u-alex' }, actor: { display_name: 'Storm Duncan' } },
      ...events,
    ];
    // Records say 14 has no owner: the unassign wrote no audit row.
    await renderRail();
    expect(within(card(14)).getByText('Unassigned')).toBeInTheDocument();
    expect(within(card(14)).queryByText(/Assigned by/)).not.toBeInTheDocument();
    applyViews('Has activity');
    expect(screen.queryByTestId('step-uuid-14')).not.toBeInTheDocument();
  });

  it('says "Older activity may not show." under Has activity when the trail read is capped (L5)', async () => {
    events = [
      ...events,
      ...Array.from({ length: 500 }, (_, i) => ({ ts: ago(10 + i), action: 'view', detail: {}, actor: { display_name: 'Storm Duncan' } })),
    ];
    await renderRail();
    expect(screen.queryByText(/Older activity may not show\./)).not.toBeInTheDocument();
    applyViews('Has activity');
    expect(screen.getByText(/Older activity may not show\./)).toBeInTheDocument();
  });

  it('holds Mine with "Reading who you are." until /me answers, never "No steps in this view." (L2)', async () => {
    window.localStorage.setItem('conductia.pref.railViewFilter', 'mine');
    const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('/api/v1/me') ? new Promise<Response>(() => {}) : base(input, init),
    );
    render(
      <FlagsProvider value={flags()}>
        <SessionProvider>
          <DealRail />
        </SessionProvider>
      </FlagsProvider>,
    );
    await screen.findByRole('region', { name: 'Rail overview' });
    expect((await screen.findAllByText('Reading who you are.')).length).toBeGreaterThan(0);
    expect(screen.queryByText('No steps in this view.')).not.toBeInTheDocument();
  });
});
