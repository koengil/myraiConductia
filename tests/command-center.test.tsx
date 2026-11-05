import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  UNASSIGNED_LABEL,
  dealRow,
  dealRows,
  dueTodayRows,
  localDayKey,
  needsYouRows,
  runningRows,
} from '../src/lib/deals/commandCenter';
import type { AppNotification } from '../src/lib/notifications/useNotifications';
import type { ListedDeal } from '../src/lib/deals/useDeals';
import { MVP_DEAL_RAIL, orderedSteps } from '../src/lib/rail/dealRail';
import { greetingForHour } from '../src/lib/util/greeting';

/*
 * The Conductor Center on the Workbench "Today" hierarchy.
 *
 * Contracts under test:
 *   1. Needs your judgment comes first; every item has exactly one primary
 *      action. It is the caller's UNREAD notifications, most consequential
 *      first.
 *   2. Due today renders only when a deal's target close is today.
 *   3. Running lists only deals whose current step has a draft run in flight
 *      (benchRunStatus 'running'), with an indeterminate activity indicator
 *      that holds still under prefers-reduced-motion; else "Nothing is
 *      running."
 *   4. Your deals: one row per deal with the seven fields (name, phase name,
 *      % of phase done from phaseProgress, 5-segment meter, current step, the
 *      assignee by name, target close, needs-you count), sortable and
 *      filterable once the list is long.
 *   5. No step numbers, entry lines or raw deal roles anywhere.
 *   6. One deal list read, no request per deal (#162).
 */

const deal = (over: Partial<ListedDeal>): ListedDeal =>
  ({
    id: 'mesa-id',
    codename: 'Mesa',
    code: 'MESAX-2026-413',
    target: 'Mesa Analytics',
    sector: 'Software',
    status: 'Signing, Closing & Post-Close',
    cursorStepId: 'p5-s57',
    entryStepSeq: 57,
    gate0Complete: true,
    dealRole: 'md',
    targetCloseDate: '2026-12-15',
    ...over,
  }) as unknown as ListedDeal;

const notification = (over: Partial<AppNotification>): AppNotification => ({
  id: 'n-1',
  deal_id: 'uuid-1',
  event_type: 'step_assigned',
  payload: { code: 'FALCN-2026-777', codename: 'Falcon', actor: 'Rob', stepId: 'p3-s39', stepTitle: 'Outreach Sequencing' },
  read_at: null,
  created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  ...over,
});

/** Mesa: assigned to Alex Chen, a draft running, 2 of 11 Closing steps done. */
const MESA = deal({
  currentStep: {
    stepId: 'p5-s57',
    seq: 57,
    phaseIndex: 5,
    title: null,
    assignee: { id: 'u-alex', name: 'Alex Chen' },
    benchRunStatus: 'running',
  },
  phaseProgress: [
    { phaseIndex: 4, done: 5, total: 5 },
    { phaseIndex: 5, done: 2, total: 11 },
  ],
});
const MESA_PERCENT = Math.round((2 / 11) * 100);
const FALCON = deal({
  id: 'falcon-id',
  codename: 'Falcon',
  code: 'FALCN-2026-777',
  status: 'Marketing & First-Round Bids',
  cursorStepId: 'p3-s39',
  entryStepSeq: 39,
  targetCloseDate: null,
});

const STEPS = orderedSteps(MVP_DEAL_RAIL);
const PHASE_5 = MVP_DEAL_RAIL.find((p) => p.index === 5)!;

/** A book of n deals spread down the rail, closing on staggered dates; every
 *  even-numbered deal has a draft running on its current step. */
function book(n: number): ListedDeal[] {
  const names = ['Alder', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fjord', 'Grove', 'Heron', 'Iris', 'Juniper', 'Kite', 'Larch'];
  return Array.from({ length: n }, (_, i) => {
    const step = STEPS[Math.min(STEPS.length - 1, 4 + i * 5)];
    return deal({
      id: `d-${i}`,
      codename: names[i] ?? `Deal ${i}`,
      code: `CODE-2026-${100 + i}`,
      cursorStepId: step.id,
      entryStepSeq: 1,
      targetCloseDate: `2027-0${(i % 9) + 1}-1${i % 10}`,
      currentStep: {
        stepId: step.id,
        seq: step.seq,
        phaseIndex: MVP_DEAL_RAIL.find((ph) => ph.steps.some((x) => x.id === step.id))!.index,
        title: null,
        assignee: null,
        benchRunStatus: i % 2 === 0 ? 'running' : null,
      },
    });
  });
}

let dealsMock: { deals: ListedDeal[]; loading: boolean };
let notificationsMock: { items: AppNotification[]; ready: boolean; error?: boolean; loaded?: boolean };
const markRead = vi.fn(async () => undefined);
const reloadNotifications = vi.fn<(opts?: { force?: boolean }) => Promise<void>>(async () => undefined);
let inboxMock: {
  items: { id: string; requesterName: string | null; destinationLabel: string; createdAt: string }[];
  busyId: string | null;
  error: string | null;
  decide: (id: string, decision: 'approved' | 'denied') => Promise<boolean>;
  match: (opts: { requestId?: string | null }) => { id: string } | null;
  reload: () => void;
};

vi.mock('@/lib/deals/useDeals', () => ({
  useDeals: () => ({ ...dealsMock, state: { status: dealsMock.loading ? 'loading' : 'ready' }, reload: () => {} }),
  useDealListSource: () => ({ apiEnabled: false, fixtureFallback: true }),
}));
let reducedMotion: boolean | null = false;
vi.mock('framer-motion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('framer-motion')>()),
  useReducedMotion: () => reducedMotion,
}));
const flagsOn = new Set<string>();
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => flagsOn.has(key),
}));
vi.mock('@/lib/notifications/useNotifications', () => ({
  useNotifications: () => ({ ...notificationsMock, unreadCount: 0, reload: reloadNotifications, markRead }),
}));
vi.mock('@/lib/access/useAccessInbox', () => ({
  useAccessInbox: () => inboxMock,
}));

let firmRole: string | null = null;
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({ state: { status: 'ready', data: { user: { firm_role: firmRole, is_external: false } } } }),
}));

import { CommandCenter, DEAL_TOOLS_AT, RUNNING_LIMIT } from '../src/components/workspace/CommandCenter';


beforeEach(() => {
  dealsMock = { deals: [MESA, FALCON], loading: false };
  notificationsMock = { items: [notification({})], ready: true };
  inboxMock = {
    items: [],
    busyId: null,
    error: null,
    decide: vi.fn(async () => true),
    match: () => null,
    reload: () => undefined,
  };
  reducedMotion = false;
});

afterEach(() => {
  firmRole = null;
  flagsOn.clear();
  cleanup();
  vi.clearAllMocks();
});

function currentStep(stepId: string): NonNullable<ListedDeal['currentStep']> {
  const step = STEPS.find((s) => s.id === stepId)!;
  return { stepId, seq: step.seq, phaseIndex: 1, title: null };
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('dealRow', () => {
  it('names the phase, its % done from the deal\'s own steps, the step, the assignee and the deep link', () => {
    const row = dealRow(MESA);
    expect(row.phase).toBe('Signing, Closing & Post-Close');
    expect(row.phaseIndex).toBe(5);
    expect(row.phasePercent).toBe(MESA_PERCENT);
    expect(row.assigneeName).toBe('Alex Chen');
    expect(row.running).toBe(true);
    expect(row.meter).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(row.stepTitle).toBe('Closing Checklist');
    expect(row.href).toBe('/projects/MESAX-2026-413/rail?step=57');
    expect(row.targetCloseDate).toBe('2026-12-15');
  });

  it('a current step on the seq-0 Gate 0 step still deep-links (0 is a step, not "none")', () => {
    const row = dealRow(deal({ cursorStepId: 'g0-notify' }));
    expect(row.stepSeq).toBe(0);
    expect(row.href).toBe('/projects/MESAX-2026-413/rail?step=0');
  });

  it('titles a custom step from its definition and claims no percentage for it', () => {
    const row = dealRow(
      deal({ currentStep: { stepId: 'custom:abc', seq: null, phaseIndex: 2, title: 'Weekly project update' } }),
    );
    expect(row.stepTitle).toBe('Weekly project update');
    expect(row.phase).toBe(MVP_DEAL_RAIL.find((p) => p.index === 2)?.name);
    expect(row.phasePercent).toBeNull();
    expect(row.meter).toEqual(['done', 'current', 'todo', 'todo', 'todo']);
    expect(row.href).toBe('/projects/MESAX-2026-413/rail');
  });

  it('keeps the deal and says so when the platform has no current step', () => {
    const row = dealRow(deal({ currentStep: null }));
    expect(row.stepTitle).toBe('No active step');
    expect(row.hasCurrentStep).toBe(false);
    expect(row.phasePercent).toBeNull();
    expect(row.href).toBe('/projects/MESAX-2026-413/rail');
  });

  it('takes the step from the platform current step, not from the catalogue cursor', () => {
    const second = STEPS[1];
    const row = dealRow(deal({ cursorStepId: 'p5-s57', currentStep: currentStep(second.id) }));
    expect(row.stepTitle).toBe(second.title);
    expect(row.href).toBe(`/projects/MESAX-2026-413/rail?step=${second.seq}`);
  });

  it('claims no % and no person when the deal list carries neither', () => {
    const row = dealRow(FALCON);
    expect(row.phasePercent).toBeNull();
    expect(row.assigneeName).toBeNull();
    expect(row.running).toBe(false);
  });

  it('counts done over total, not where the current step sits', () => {
    const row = dealRow(
      deal({
        cursorStepId: PHASE_5.steps[0].id,
        currentStep: { stepId: PHASE_5.steps[0].id, seq: PHASE_5.steps[0].seq, phaseIndex: 5, title: null },
        phaseProgress: [{ phaseIndex: 5, done: 3, total: 4 }],
      }),
    );
    expect(row.phasePercent).toBe(75);
  });

  it('counts the unread items that need you on each deal', () => {
    const items = needsYouRows([notification({}), notification({ id: 'n-2', event_type: 'compliance_hold' })]);
    expect(dealRow(FALCON, items).needsYou).toBe(2);
    expect(dealRow(MESA, items).needsYou).toBe(0);
  });

  it('lists the furthest-along deal first, a deal with no current step last', () => {
    expect(dealRows([FALCON, deal({ id: 'x', codename: 'Zed', currentStep: null }), MESA]).map((r) => r.codename)).toEqual([
      'Mesa',
      'Falcon',
      'Zed',
    ]);
  });
});

describe('runningRows and dueTodayRows', () => {
  it('Running holds only deals with a draft run in flight on the current step', () => {
    const done = deal({
      id: 'done',
      codename: 'Quill',
      currentStep: { stepId: 'p5-s57', seq: 57, phaseIndex: 5, title: null, benchRunStatus: 'complete' },
    });
    const rows = dealRows([MESA, FALCON, done]);
    expect(runningRows(rows).map((r) => r.codename)).toEqual(['Mesa']);
  });

  it('Due today is the deals whose target close is today, and nothing else', () => {
    const now = new Date(2026, 9, 22, 9, 0, 0);
    const rows = dealRows([deal({ targetCloseDate: localDayKey(now) }), FALCON]);
    expect(dueTodayRows(rows, now).map((r) => r.codename)).toEqual(['Mesa']);
    expect(dueTodayRows(dealRows([MESA, FALCON]), now)).toEqual([]);
  });
});

describe('needsYouRows', () => {
  it('unread only, titled by the step when the payload names one, deep-linked to it, one action', () => {
    const rows = needsYouRows([notification({}), notification({ id: 'n-2', read_at: new Date().toISOString() })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Outreach Sequencing');
    expect(rows[0].codename).toBe('Falcon');
    expect(rows[0].meta).toContain('Step assigned to you');
    expect(rows[0].meta).toContain('Rob');
    expect(rows[0].href).toBe('/projects/FALCN-2026-777/rail?step=39');
    expect(rows[0].actionLabel).toBe('Open step');
  });

  it('a non-step event is titled by its label and links to the deal rail', () => {
    const rows = needsYouRows([
      notification({ id: 'n-3', event_type: 'compliance_hold', payload: { code: 'MESAX-2026-413', codename: 'Mesa' } }),
    ]);
    expect(rows[0].title).toBe('Compliance hold');
    expect(rows[0].href).toBe('/projects/MESAX-2026-413/rail');
    expect(rows[0].actionLabel).toBe('Review hold');
  });

  it('a stored UUID link opens the deal by its code', () => {
    const rows = needsYouRows([
      notification({
        id: 'n-uuid',
        event_type: 'compliance_hold',
        payload: { code: 'MESAX-2026-413', codename: 'Mesa', href: '/projects/45b3e075-1111-4222-8333-444455556666/mail?folder=held' },
      }),
    ]);
    expect(rows[0].href).toBe('/projects/MESAX-2026-413/mail?folder=held');
  });

  it('puts the most consequential first: hold, access, NDA, then assigned steps', () => {
    const rows = needsYouRows([
      notification({ id: 'a' }),
      notification({ id: 'b', event_type: 'nda_pending', payload: { code: 'X', codename: 'X' } }),
      notification({ id: 'c', event_type: 'compliance_hold', payload: { code: 'X', codename: 'X' } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('informational events (signed, promoted, completed…) are not "needs you"', () => {
    const rows = needsYouRows([
      notification({ id: 'n-5', event_type: 'nda_signed', payload: { code: 'MESAX-2026-413', codename: 'Mesa' } }),
      notification({ id: 'n-6', event_type: 'step_completed', payload: { code: 'MESAX-2026-413', codename: 'Mesa' } }),
      notification({ id: 'n-7', event_type: 'nda_pending', payload: { code: 'MESAX-2026-413', codename: 'Mesa' } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['n-7']);
  });

  it('a payload with no deal code yields no link, and its one action clears it', () => {
    const rows = needsYouRows([notification({ id: 'n-4', event_type: 'compliance_hold', payload: {} })]);
    expect(rows[0].href).toBeNull();
    expect(rows[0].actionLabel).toBe('Mark as read');
  });

  it('titles an access request by who asked for what, and never repeats its label', () => {
    const rows = needsYouRows([
      notification({
        id: 'n-access',
        event_type: 'access_requested',
        payload: { actor: 'Rob', destinationLabel: 'Leads', requestId: 'req-1' },
      }),
    ]);
    expect(rows[0].title).toBe('Rob asks for access to Leads');
    expect(rows[0].meta.match(/Access request/g)).toHaveLength(1);
    expect(rows[0].meta).not.toContain('Rob');
    expect(rows[0].meta).not.toContain('Leads');
  });

  it('a non-step item titled by its label does not repeat the label in its meta', () => {
    const [row] = needsYouRows([
      notification({ id: 'n-3', event_type: 'compliance_hold', payload: { code: 'MESAX-2026-413', codename: 'Mesa' } }),
    ]);
    expect(row.title).toBe('Compliance hold');
    expect(row.meta).not.toContain('Compliance hold');
  });

  it('does not deep-link an access request to the locked destination', () => {
    const rows = needsYouRows([
      notification({
        id: 'n-access',
        event_type: 'access_requested',
        payload: { actor: 'Rob', destinationLabel: 'Leads', href: '/leads', requestId: 'req-1', companyId: 'co-1' },
      }),
    ]);
    expect(rows[0].href).toBeNull();
    expect(rows[0].requestId).toBe('req-1');
    expect(rows[0].destinationLabel).toBe('Leads');
  });
});

describe('CommandCenter', () => {
  it('stays quiet while the deal list loads: no "0 live deals" line', () => {
    dealsMock = { deals: [], loading: true };
    render(<CommandCenter />);
    expect(screen.getByText(greetingForHour(new Date().getHours()))).toBeInTheDocument();
    expect(screen.queryByText(/live deals\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 live deals/)).not.toBeInTheDocument();
  });

  it('follows the Today hierarchy: judgment first, then Running, then Your deals', () => {
    render(<CommandCenter />);
    expect(screen.getByText('1 decision needs your judgment across 2 live deals.')).toBeInTheDocument();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Needs your judgment', 'Running', 'Your deals']);
  });

  it('every item in Needs your judgment has exactly one primary action', () => {
    notificationsMock = {
      items: [
        notification({}),
        notification({ id: 'n-h', event_type: 'compliance_hold', payload: { code: 'MESAX-2026-413', codename: 'Mesa' } }),
        notification({ id: 'n-x', event_type: 'nda_pending', payload: {} }),
        notification({
          id: 'n-access',
          event_type: 'access_requested',
          payload: { actor: 'Rob', destinationLabel: 'Leads', requestId: 'req-1' },
        }),
      ],
      ready: true,
    };
    inboxMock = { ...inboxMock, match: () => ({ id: 'req-1' }) };
    render(<CommandCenter />);
    const rows = within(section('Needs your judgment')).getAllByTestId('needs-you-row');
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.querySelectorAll('[data-primary-action]')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Review hold, Mesa: Compliance hold' })).toHaveAttribute(
      'href',
      '/projects/MESAX-2026-413/rail',
    );
  });

  it('an empty queue says so plainly', () => {
    notificationsMock = { items: [], ready: true };
    render(<CommandCenter />);
    expect(screen.getByText('Nothing needs your judgment.')).toBeInTheDocument();
    expect(screen.getByText('0 decisions need your judgment across 2 live deals.')).toBeInTheDocument();
  });

  it('a failed first notifications read is not an empty desk', () => {
    notificationsMock = { items: [], ready: true, error: true, loaded: false };
    render(<CommandCenter />);
    expect(screen.getByText("Couldn't load what needs you.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b0 decisions\b/);
    expect(screen.queryByText('Nothing needs your judgment.')).toBeNull();
    expect(within(section('Needs your judgment')).queryByText(/0 open/)).toBeNull();
    // The Needs-you cells show nothing rather than a false 0.
    for (const cell of screen.getAllByTestId('needs-you-count')) expect(cell).toHaveTextContent('');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reloadNotifications).toHaveBeenCalledTimes(1);
    // Forced, so a retry right after the failed read is never swallowed by the 30 s reload window.
    expect(reloadNotifications).toHaveBeenCalledWith({ force: true });
  });

  it('before the first notifications read resolves, no decision count shows', () => {
    notificationsMock = { items: [], ready: false };
    render(<CommandCenter />);
    expect(document.body.textContent).not.toMatch(/\bdecisions?\b/);
    expect(screen.queryByText('Nothing needs your judgment.')).toBeNull();
    expect(within(section('Needs your judgment')).queryByText(/open$/)).toBeNull();
    for (const cell of screen.getAllByTestId('needs-you-count')) expect(cell).toHaveTextContent('');
  });

  it('a failed refetch after a good load keeps the count and the items', () => {
    notificationsMock = {
      items: Array.from({ length: 6 }, (_, i) => notification({ id: `n-${i}` })),
      ready: true,
      error: true,
      loaded: true,
    };
    render(<CommandCenter />);
    expect(screen.getByText('6 decisions need your judgment across 2 live deals.')).toBeInTheDocument();
    expect(within(section('Needs your judgment')).getAllByTestId('needs-you-row')).toHaveLength(6);
    expect(screen.queryByText("Couldn't load what needs you.")).toBeNull();
  });

  it('pressing a row\'s primary link marks that item read', () => {
    render(<CommandCenter />);
    const link = within(section('Needs your judgment')).getByRole('link', { name: /Open step/ });
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(markRead).toHaveBeenCalledWith('n-1');
  });

  it('titles wrap to two lines and carry their full text', () => {
    const long = 'Outreach Sequencing for the second wave of strategic buyers in the Asia Pacific region';
    notificationsMock = {
      items: [notification({ payload: { code: 'FALCN-2026-777', codename: 'Falcon', stepTitle: long } })],
      ready: true,
    };
    render(<CommandCenter />);
    const title = within(section('Needs your judgment')).getByText(long);
    expect(title).not.toHaveClass('truncate');
    expect(title).toHaveClass('line-clamp-2');
    expect(title).toHaveAttribute('title', long);
  });

  it('a long codename wraps in Your deals instead of clipping', () => {
    render(<CommandCenter />);
    const link = within(section('Your deals')).getByRole('link', { name: 'Mesa' });
    expect(link).toHaveClass('min-w-0');
    expect(link).toHaveClass('break-words');
  });

  it('a no-link item is cleared by its one action', () => {
    notificationsMock = { items: [notification({ id: 'n-4', event_type: 'compliance_hold', payload: {} })], ready: true };
    render(<CommandCenter />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
    expect(markRead).toHaveBeenCalledWith('n-4');
  });

  it('Running shows only a draft actually in flight, with an activity bar that never claims progress', () => {
    render(<CommandCenter />);
    const running = section('Running');
    const rows = within(running).getAllByTestId('running-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Closing Checklist');
    expect(rows[0]).toHaveTextContent('Mesa');
    expect(rows[0]).toHaveTextContent('Conductia is drafting');
    expect(rows[0]).not.toHaveTextContent('%');
    expect(within(running).queryByText(/Falcon/)).toBeNull();
    const indicator = within(running).getByTestId('running-indicator');
    expect(indicator).toHaveAttribute('data-motion', 'animated');
    expect(indicator.getAttribute('style') ?? '').not.toMatch(/width/);
    expect(within(running).getByRole('link', { name: /Closing Checklist/ })).toHaveAttribute(
      'href',
      '/projects/MESAX-2026-413/rail?step=57',
    );
  });

  it('Running holds still under prefers-reduced-motion, and before the preference is known', () => {
    reducedMotion = true;
    render(<CommandCenter />);
    expect(within(section('Running')).getByTestId('running-indicator')).toHaveAttribute('data-motion', 'static');
    cleanup();
    reducedMotion = null;
    render(<CommandCenter />);
    expect(within(section('Running')).getByTestId('running-indicator')).toHaveAttribute('data-motion', 'static');
  });

  it('with no draft in flight, there is no Running section and no Running filter', async () => {
    dealsMock = {
      deals: book(DEAL_TOOLS_AT).map((d) => ({ ...d, currentStep: { ...d.currentStep!, benchRunStatus: null } })),
      loading: false,
    };
    notificationsMock = { items: [], ready: true };
    render(<CommandCenter />);
    expect(screen.queryByRole('region', { name: 'Running' })).toBeNull();
    expect(screen.queryByText('Nothing is running.')).toBeNull();
    expect(screen.queryByTestId('running-indicator')).toBeNull();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Needs your judgment', 'Your deals']);
    fireEvent.keyDown(screen.getByRole('button', { name: /Show/ }), { key: 'Enter' });
    const options = (await screen.findAllByRole('menuitemradio')).map((o) => o.textContent);
    expect(options).toEqual(['All deals', 'Needs you']);
  });

  it('Your deals shows the seven fields on every row', () => {
    render(<CommandCenter />);
    const rows = within(section('Your deals')).getAllByTestId('deal-row');
    expect(rows).toHaveLength(2);
    const mesa = rows.find((r) => r.dataset.deal === 'Mesa')!;
    const pct = MESA_PERCENT;
    expect(within(mesa).getByRole('link', { name: 'Mesa' })).toHaveAttribute('href', '/projects/MESAX-2026-413');
    expect(mesa).toHaveTextContent('Signing, Closing & Post-Close');
    expect(mesa).toHaveTextContent(`${pct}% done`);
    expect(within(mesa).getByRole('img', { name: `Signing, Closing & Post-Close, ${pct}% done` })).toBeInTheDocument();
    expect(within(mesa).getByTestId('phase-meter').querySelectorAll('[data-state]')).toHaveLength(5);
    expect(within(mesa).getByRole('link', { name: 'Open Mesa: Closing Checklist' })).toHaveAttribute(
      'href',
      '/projects/MESAX-2026-413/rail?step=57',
    );
    expect(mesa).toHaveTextContent('Alex Chen');
    expect(mesa).not.toHaveTextContent(UNASSIGNED_LABEL);
    expect(mesa).toHaveTextContent('Dec 15, 2026');
    expect(within(mesa).getByTestId('needs-you-count')).toHaveTextContent('0 items need you');
    const falcon = rows.find((r) => r.dataset.deal === 'Falcon')!;
    expect(falcon).toHaveTextContent('Not set');
    // No assignee in the list: "Unassigned", never "You".
    expect(falcon).toHaveTextContent('Unassigned');
    expect(within(falcon).queryByText('You')).toBeNull();
    expect(within(falcon).getByTestId('needs-you-count')).toHaveTextContent('1 item needs you');
  });

  it('a deal with no current step names no one as on it', () => {
    dealsMock = { deals: [deal({ currentStep: null })], loading: false };
    render(<CommandCenter />);
    const row = screen.getByTestId('deal-row');
    expect(row).toHaveTextContent('No active step');
    expect(row).toHaveTextContent('No one');
    expect(within(row).queryByText('You')).toBeNull();
  });

  it('shows no step numbers, entry lines or raw deal roles', () => {
    render(<CommandCenter />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/Station|station|Entered at|execution rail/);
    for (const row of screen.getAllByTestId('deal-row')) {
      expect(within(row).queryByText('md')).toBeNull();
      expect(row.textContent).not.toMatch(/\bmd\b|deal_team/);
    }
    const labels = Array.from(document.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label'));
    expect(labels.join(' ')).not.toMatch(/[Ss]tation/);
  });

  it('Due today renders only when a target close is today', () => {
    render(<CommandCenter />);
    expect(screen.queryByText('Due today')).not.toBeInTheDocument();
    cleanup();
    dealsMock = { deals: [deal({ targetCloseDate: localDayKey(new Date()) }), FALCON], loading: false };
    render(<CommandCenter />);
    const due = section('Due today');
    expect(within(due).getByText('Mesa closes today')).toBeInTheDocument();
    expect(within(due).getByRole('link', { name: 'Open Mesa' })).toHaveAttribute('href', '/projects/MESAX-2026-413');
  });

  it('keeps a short list plain: no sort or filter controls under the threshold', () => {
    dealsMock = { deals: book(DEAL_TOOLS_AT - 1), loading: false };
    render(<CommandCenter />);
    expect(screen.getAllByTestId('deal-row')).toHaveLength(DEAL_TOOLS_AT - 1);
    expect(screen.queryByRole('searchbox', { name: 'Find a deal' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sort by/ })).toBeNull();
  });

  it('scales to a 12-deal book: one list, sortable, filterable by phase, status and name', async () => {
    dealsMock = { deals: book(12), loading: false };
    notificationsMock = { items: [], ready: true };
    render(<CommandCenter />);
    expect(screen.getByRole('searchbox', { name: 'Find a deal' })).toBeInTheDocument();
    const deals = section('Your deals');
    expect(within(deals).getAllByTestId('deal-row')).toHaveLength(12);
    expect(within(deals).getByText('12 deals')).toBeInTheDocument();

    // Sort by target close: soonest first.
    fireEvent.keyDown(within(deals).getByRole('button', { name: /Sort by/ }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Target close' }));
    await waitFor(() => {
      const closes = within(deals)
        .getAllByTestId('deal-row')
        .map((r) => r.dataset.deal);
      const expected = book(12)
        .slice()
        .sort((a, b) => (a.targetCloseDate ?? '').localeCompare(b.targetCloseDate ?? '') || a.codename.localeCompare(b.codename))
        .map((d) => d.codename);
      expect(closes).toEqual(expected);
    });
    const closeHeader = within(deals).getByRole('columnheader', { name: 'Target close' });
    expect(closeHeader).toHaveAttribute('aria-sort', 'ascending');

    // Filter by phase.
    fireEvent.keyDown(within(deals).getByRole('button', { name: /Phase/ }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitemradio', { name: PHASE_5.name }));
    await waitFor(() => {
      const rows = within(deals).getAllByTestId('deal-row');
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r).toHaveTextContent(PHASE_5.name);
    });
    expect(within(deals).getByText(/of 12 deals/)).toBeInTheDocument();

    // Find by name narrows further; no match offers a way back.
    fireEvent.change(within(deals).getByRole('searchbox', { name: 'Find a deal' }), { target: { value: 'zzz' } });
    expect(within(deals).getByText('No deals match.')).toBeInTheDocument();
    fireEvent.click(within(deals).getByRole('button', { name: 'Clear filters' }));
    expect(within(deals).getAllByTestId('deal-row')).toHaveLength(12);
  });

  it('caps Running and hands the rest to Your deals, filtered to running', async () => {
    dealsMock = { deals: book(12), loading: false };
    notificationsMock = { items: [], ready: true };
    render(<CommandCenter />);
    const running = section('Running');
    const total = runningRows(dealRows(book(12))).length;
    expect(total).toBeGreaterThan(RUNNING_LIMIT);
    expect(within(running).getAllByTestId('running-row')).toHaveLength(RUNNING_LIMIT);
    fireEvent.click(within(running).getByRole('button', { name: `Show all ${total} in Your deals` }));
    await waitFor(() => expect(within(section('Your deals')).getAllByTestId('deal-row')).toHaveLength(total));
    expect(within(section('Your deals')).getByRole('button', { name: /Show/ })).toHaveTextContent('Running');
  });

  it('lets an administrator approve an access request without leaving the center', async () => {
    const decide = vi.fn(async () => true);
    notificationsMock = {
      items: [
        notification({
          id: 'n-access',
          event_type: 'access_requested',
          payload: { actor: 'Rob', destinationLabel: 'Leads', href: '/leads', requestId: 'req-1', companyId: 'co-1' },
        }),
      ],
      ready: true,
    };
    inboxMock = { ...inboxMock, decide, match: () => ({ id: 'req-1' }) };
    render(<CommandCenter />);
    expect(document.querySelector('a[href="/leads"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('req-1', 'approved'));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('n-access'));
  });

  it('lets an administrator deny an access request without leaving the center', async () => {
    const decide = vi.fn(async () => true);
    notificationsMock = {
      items: [
        notification({
          id: 'n-access',
          event_type: 'access_requested',
          payload: { actor: 'Rob', destinationLabel: 'Leads', href: '/leads', requestId: 'req-1', companyId: 'co-1' },
        }),
      ],
      ready: true,
    };
    inboxMock = { ...inboxMock, decide, match: () => ({ id: 'req-1' }) };
    render(<CommandCenter />);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith('req-1', 'denied'));
  });

  it('does not offer approve/deny when the access request has already been decided', () => {
    notificationsMock = {
      items: [
        notification({
          id: 'n-access',
          event_type: 'access_requested',
          payload: { actor: 'Martín', destinationLabel: 'Leads', href: '/leads', requestId: 'req-decided', companyId: 'co-1' },
        }),
      ],
      ready: true,
    };
    inboxMock = { ...inboxMock, match: () => null };
    render(<CommandCenter />);
    expect(screen.getByText('Martín asks for access to Leads')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('names each deal at its platform current step from the one deal list, with no request per deal', () => {
    flagsOn.add('project_rail_model');
    flagsOn.add('gate0_api_create');
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const second = STEPS[1];
    dealsMock = {
      deals: [
        { ...MESA, currentStep: { stepId: 'custom:abc', seq: null, phaseIndex: 5, title: 'Weekly project update' } },
        { ...FALCON, currentStep: currentStep(second.id) },
      ],
      loading: false,
    };

    try {
      render(<CommandCenter />);
      expect(screen.getByRole('link', { name: 'Open Mesa: Weekly project update' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: `Open Falcon: ${second.title}` })).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers one "Open {deal}: {step}" link per deal, the name e2e steps rely on', () => {
    render(<CommandCenter />);
    expect(screen.getAllByRole('link', { name: 'Open Mesa: Closing Checklist' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Open Falcon: Outreach Sequencing' })).toHaveLength(1);
  });

  it('no fixture tasks remain: Summit and Harbor are not on the page', () => {
    render(<CommandCenter />);
    expect(screen.queryByText(/Project Summit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Project Harbor/)).not.toBeInTheDocument();
  });
});

describe('CommandCenter discovery line', () => {
  function candidatesFetch(candidates: unknown[], ok = true) {
    const spy = vi.fn(async () =>
      ok ? new Response(JSON.stringify({ candidates }), { status: 200 }) : new Response('{}', { status: 500 }),
    );
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('with proposals: "N new deals found in your mail" and a Review link to /discovery', async () => {
    flagsOn.add('deal_discovery');
    candidatesFetch([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    render(<CommandCenter />);
    const line = await screen.findByTestId('discovery-line');
    expect(line).toHaveTextContent('3 new deals found in your mail');
    expect(within(line).getByRole('link', { name: /Review/ })).toHaveAttribute('href', '/discovery');
    expect(line.textContent).not.toMatch(/watching|monitor|scanning|tracking/i);
  });

  it("the control room (cco) sees every proposal, so the line says \"your firm's mail\"", async () => {
    firmRole = 'cco';
    flagsOn.add('deal_discovery');
    candidatesFetch([{ id: 'c1' }, { id: 'c2' }]);
    render(<CommandCenter />);
    expect(await screen.findByTestId('discovery-line')).toHaveTextContent("2 new deals found in your firm's mail");
  });

  it('singular for one proposal', async () => {
    flagsOn.add('deal_discovery');
    candidatesFetch([{ id: 'c1' }]);
    render(<CommandCenter />);
    expect(await screen.findByTestId('discovery-line')).toHaveTextContent('1 new deal found in your mail');
  });

  it('with none, or when the read fails, shows nothing', async () => {
    flagsOn.add('deal_discovery');
    const spy = candidatesFetch([]);
    const { unmount } = render(<CommandCenter />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/v1/discovery/candidates', expect.anything()));
    expect(screen.queryByTestId('discovery-line')).toBeNull();
    unmount();
    candidatesFetch([], false);
    render(<CommandCenter />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('discovery-line')).toBeNull();
  });

  it('with Discovery off, makes no request and shows nothing', () => {
    const spy = candidatesFetch([{ id: 'c1' }]);
    render(<CommandCenter />);
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByTestId('discovery-line')).toBeNull();
  });
});

describe('CommandCenter greeting', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('greets by the reader clock, not a fixed morning', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 31, 21, 0, 0));
    render(<CommandCenter />);
    expect(screen.getByText('Good evening.')).toBeInTheDocument();
    expect(screen.queryByText('Good morning.')).not.toBeInTheDocument();
  });

  it('renders no clock-dependent greeting on the first paint, so hydration matches', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 31, 21, 0, 0));
    const html = renderToString(<CommandCenter />);
    expect(html).not.toContain('Good evening.');
    expect(html).not.toContain('Good morning.');
  });
});
