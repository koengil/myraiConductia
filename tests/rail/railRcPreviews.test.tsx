import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';

import { DealRail } from '@/components/rail/DealRail';
import { DONT_ASK_CONFIRM_MS } from '@/components/rail/RailEditPrompt';
import { abortAllReads } from '@/lib/api/inflightRead';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { DEAL_RAIL, MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { DealStepRecord } from '@/lib/rail/dealStepRecord';
import { SessionProvider } from '@/lib/session/store';
import { MotionGlobalConfig } from 'framer-motion';

// Overlay exits finish at once, so a test awaits a close without running the
// real 180 ms motion. tests/overlay/dialog.test.tsx keeps the exit on real motion.
beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

/*
 * The deal rail, real-deal path: the reorder Preview (Move to…, Reset, the
 * saved numbers kept), Remove in the card menu, the edit prompt for people
 * with rail editing rights, the who-can-change line, "Propose a change" with
 * the deal lead's tray, and the dependency view with drawn links and dates.
 * Every Preview writes nothing to the server.
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
let canEdit = true;
const apiDeal = () => ({
  id: 'uuid-summit',
  code: DEAL,
  codename: 'Project Summit',
  status: 'active',
  createdAt: '2026-07-15T00:00:00Z',
  entryStepSeq: 26,
  currentStepSeq: 26,
  targetName: null,
  dealRole,
  conflictsApprovedBy: null,
  conflictsApprovedOn: null,
});

const SEQS = [26, 27, 28, 29, 30, 31];
/** Steps the DELETE removed (the next rail read leaves them out). */
let removedSeqs = new Set<number>();
/** Saved statuses that differ from the default (current 26, complete 27). */
let statusOf: Record<number, string> = {};
function serverRail() {
  return {
    currentStepId: 'uuid-26',
    canEditStructure: canEdit,
    canSaveTemplate: canEdit,
    phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
    steps: SEQS.filter((seq) => !removedSeqs.has(seq)).map((seq, i) => ({
      id: `uuid-${seq}`,
      stepId: bySeq(seq).id,
      origin: 'catalog',
      phaseIndex: phaseForStep(bySeq(seq).id, MVP_DEAL_RAIL)?.index ?? 1,
      displayOrder: i + 1,
      seq,
      status: statusOf[seq] ?? (seq === 26 ? 'current' : seq === 27 ? 'complete' : 'pending'),
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
  return { ...map, gate0_api_create: true, platform_onboarding: true, project_rail_model: true, rail_templates: true };
}

beforeEach(() => {
  dealRole = 'md';
  canEdit = true;
  removedSeqs = new Set();
  statusOf = {};
  window.localStorage.clear();
  records = [
    rec(26, 'current', { assignedTo: 'u-alex', assignedToName: 'Alex Chen' }),
    rec(27, 'complete', {
      assignedTo: 'u-morgan',
      assignedToName: 'Morgan Vale',
      completedBy: 'u-morgan',
      completedByName: 'Morgan Vale',
      completedAt: ago(1),
    }),
    rec(28, 'pending'),
    rec(29, 'pending', { assignedTo: 'u-storm', assignedToName: 'Storm Duncan' }),
    rec(30, 'pending'),
    rec(31, 'pending', { assignedTo: 'u-morgan', assignedToName: 'Morgan Vale' }),
  ];
  events = [
    { ts: ago(1), action: 'complete_step', detail: { stepId: bySeq(27).id }, actor: { display_name: 'Morgan Vale' } },
    { ts: ago(2), action: 'step_work', detail: { stepId: bySeq(26).id }, actor: { display_name: 'Alex Chen' } },
    { ts: ago(3), action: 'assign_step', detail: { stepId: bySeq(29).id }, actor: { display_name: 'Storm Duncan' } },
    { ts: ago(3), action: 'assign_step', detail: { stepId: bySeq(26).id }, actor: { display_name: 'Storm Duncan' } },
  ];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v1/deals') return json({ deals: [apiDeal()] });
    if (url === `/api/v1/deals/${DEAL}/rail`) return json(serverRail());
    if (url.endsWith('/step-records')) return json({ records });
    if (url.endsWith('/audit')) return json({ deal: {}, events });
    if (url.includes('/steps/') && (init?.method ?? 'GET') === 'GET') {
      return json({
        step: { assignedTo: null },
        members: [
          { id: 'u-storm', name: 'Storm Duncan', dealRole: 'md' },
          { id: 'u-alex', name: 'Alex Chen', dealRole: 'deal_team' },
        ],
        permissions: { canAssign: true },
      });
    }
    if (url.includes('/steps/') && init?.method === 'PATCH') return json({ step: {} });
    if (url.includes('/rail/steps/') && init?.method === 'DELETE') {
      const seq = SEQS.find((x) => url.includes(`uuid-${x}`) || url.includes(encodeURIComponent(bySeq(x).id)));
      if (seq !== undefined) removedSeqs.add(seq);
      return json({});
    }
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
const writes = () => calls((_u, init) => (init?.method ?? 'GET') !== 'GET');
// The board is off the page while a step is zoomed, and a prompt may be open over it.
const stackOrder = () =>
  within(within(screen.getByRole('region', { name: 'Rail overview', hidden: true })).getByRole('list', { name: 'Preparation steps', hidden: true }))
    .queryAllByRole('button', { name: /^Step \d+ · /, hidden: true })
    .map((b) => b.getAttribute('aria-label'));

/** Zooms into a step: Move to…, Assign… and Remove live in its detail. */
async function openStep(seq: number) {
  fireEvent.click(within(card(seq)).getByRole('button', { name: /^Step \d+ · / }));
  return screen.findByRole('region', { name: 'Step detail' });
}

async function zoomOut() {
  fireEvent.click(screen.getByRole('button', { name: /^Zoom out to /, hidden: true }));
  return screen.findByRole('region', { name: 'Rail overview', hidden: true });
}

/** Moving is off until Edit rail turns it on. */
function startEditing() {
  const edit = screen.queryByRole('button', { name: 'Edit rail' });
  if (edit) fireEvent.click(edit);
}

async function openMoveDialog(seq: number) {
  startEditing();
  const detail = await openStep(seq);
  fireEvent.click(within(detail).getByRole('button', { name: 'Move to…' }));
  return screen.findByRole('dialog', { name: title(seq) });
}

/** Moves a step to the earliest place the Preview allows (right after the done step 27), back on the board. */
async function moveFirst(seq: number) {
  const dialog = await openMoveDialog(seq);
  fireEvent.click(within(dialog).getAllByRole('radio')[0]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move step' }));
  await zoomOut();
}

/** Remove from step detail: its inline confirm, then the existing DELETE. */
async function removeFromDetail(seq: number) {
  const detail = await openStep(seq);
  fireEvent.click(within(detail).getByRole('button', { name: 'Remove', exact: true } as never));
  fireEvent.click(within(detail).getByRole('button', { name: 'Remove step' }));
}

describe('reorder Preview', () => {
  it('moves nothing until Edit rail is on, then says what a move does, and Done turns it off', async () => {
    await renderRail();
    expect(card(30).querySelector('[data-card-grip]')).toBeNull();
    const off = await openStep(30);
    expect(within(off).queryByRole('button', { name: 'Move to…' })).not.toBeInTheDocument();
    await zoomOut();

    fireEvent.click(screen.getByRole('button', { name: 'Edit rail' }));
    expect(screen.getByText('Drag a step that is still open to move it. Only you see the new order.')).toBeInTheDocument();
    expect(card(30).querySelector('[data-card-grip]')).not.toBeNull();
    // A done step stays where it is: no grip.
    expect(card(27).querySelector('[data-card-grip]')).toBeNull();
    const on = await openStep(30);
    expect(within(on).getByRole('button', { name: 'Move to…' })).toBeInTheDocument();
    await zoomOut();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(card(30).querySelector('[data-card-grip]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit rail' })).toBeInTheDocument();
  });

  it('moves a step by Move to…, keeps its saved number, marks it Preview and saves nothing', async () => {
    await renderRail();
    expect(stackOrder()[0]).toContain(title(26));
    const before = writes();

    await moveFirst(30);

    expect(stackOrder()[2]).toBe(`Step 05 · ${title(30)} · To do`);
    expect(within(card(30)).getByText('Moved in this browser')).toBeInTheDocument();
    expect(screen.getByText('Only you see this. Nothing here is saved to the deal.', { exact: false })).toBeInTheDocument();
    // The board banner stays in view at phone width, so Reset is reachable.
    const banner = document.querySelector('[data-preview="banner"]') as HTMLElement;
    expect(banner.className).toContain('sticky');
    expect(banner.className).toContain('top-0');
    expect(banner.className).toContain('sm:static');
    expect(writes()).toBe(before);

    // The edit prompt states the Preview truth: kept in this browser, not saved.
    const prompt = await screen.findByRole('dialog', { name: `${title(30)} moved` });
    expect(
      within(prompt).getByText('Only you see this order. It is kept in this browser and is not saved to the deal.'),
    ).toBeInTheDocument();
    expect(prompt.textContent).not.toMatch(/changes the rail for everyone/);
    expect(within(prompt).queryByRole('button', { name: 'Apply to this deal' })).not.toBeInTheDocument();
    fireEvent.click(within(prompt).getByRole('button', { name: 'Keep in this browser' }));
    expect(writes()).toBe(before);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(stackOrder()[2]).toContain(title(28));
    expect(screen.queryByText('Moved in this browser')).not.toBeInTheDocument();
  });

  it('offers no Move to… on a done step, and gives the card button its own name, not "sortable"', async () => {
    await renderRail();
    startEditing();
    const detail = await openStep(27);
    expect(within(detail).queryByRole('button', { name: 'Move to…' })).not.toBeInTheDocument();
    await zoomOut();
    const button = within(card(28)).getByRole('button', { name: new RegExp(`^Step 03 · ${title(28)}`) });
    expect(button).not.toHaveAttribute('aria-roledescription');
  });

  it('reverts on reload: the new order is held in memory only', async () => {
    const board = await renderRail();
    await moveFirst(30);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep in this browser' }));
    cleanup();
    abortAllReads();
    const again = await renderRail();
    expect(stackOrder()[2]).toContain(title(28));
    expect(board).not.toBe(again);
  });
});

describe('edit prompt', () => {
  it('after a remove, offers exactly the three actions; save as a company rail opens Save rail', async () => {
    await renderRail();
    await removeFromDetail(28);
    const prompt = await screen.findByRole('dialog', { name: `${title(28)} removed` });
    const actions = within(prompt)
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t !== '');
    expect(actions).toEqual(expect.arrayContaining(["Don't ask again", 'Apply and save as a company rail…', 'Apply to this deal']));
    // There is no personal rail: a saved change never implies one.
    expect(prompt.textContent).not.toMatch(/only you|just for you|personal rail|your copy/i);
    fireEvent.click(within(prompt).getByRole('button', { name: 'Apply and save as a company rail…' }));
    expect(await screen.findByRole('dialog', { name: 'Save rail' })).toBeInTheDocument();
  });

  it('after a move, offers Keep in this browser and Reset, never Apply; Reset restores the saved order', async () => {
    await renderRail();
    const before = writes();
    await moveFirst(30);
    const prompt = await screen.findByRole('dialog', { name: `${title(30)} moved` });
    const actions = within(prompt)
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t !== '');
    expect(actions).toEqual(expect.arrayContaining(["Don't ask again", 'Reset', 'Keep in this browser']));
    expect(actions).not.toContain('Apply to this deal');
    expect(actions).not.toContain('Apply and save as a company rail…');
    expect(prompt.textContent).not.toMatch(/changes the rail for everyone/);

    fireEvent.click(within(prompt).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(stackOrder()[2]).toContain(title(28));
    expect(screen.queryByText('Moved in this browser')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing here is saved to the deal/)).not.toBeInTheDocument();
    expect(writes()).toBe(before);
  });

  it('Save rail says a Preview order is not included while one is active', async () => {
    await renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Save rail' }));
    let dialog = await screen.findByRole('dialog', { name: 'Save rail' });
    expect(within(dialog).queryByText(/The order you moved in this browser is not included/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await moveFirst(30);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep in this browser' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save rail' }));
    dialog = await screen.findByRole('dialog', { name: 'Save rail' });
    expect(
      within(dialog).getByText(
        "The order you moved in this browser is not included. The saved rail keeps the deal's saved order.",
      ),
    ).toBeInTheDocument();
  });

  it("Don't ask again stores the choice here, confirms for about two seconds, and stops the prompt", async () => {
    await renderRail();
    await moveFirst(30);
    const prompt = await screen.findByRole('dialog', { name: `${title(30)} moved` });
    // The confirmation's clock is faked, so "about two seconds" is exact and instant.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // A pointer press (detail 1): the confirmation leaves focus where it is.
      fireEvent.click(within(prompt).getByRole('button', { name: "Don't ask again" }), { detail: 1 });
      expect(window.localStorage.getItem('conductia.pref.railEditPrompt')).toBe('never');
      const note = screen.getByText(/You can change this in/).closest('[role="status"]') as HTMLElement;
      expect(note).toHaveTextContent('You can change this in Settings › Rails.');
      expect(within(note).getByRole('link', { name: 'Settings › Rails' })).toHaveAttribute('href', '/settings?section=rails');
      act(() => vi.advanceTimersByTime(DONT_ASK_CONFIRM_MS - 1));
      expect(screen.getByText(/You can change this in/)).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText(/You can change this in/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }

    await moveFirst(31);
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: `${title(31)} moved` })).not.toBeInTheDocument();
  });

  it("Don't ask again says so when this browser refuses to keep it, and the prompt returns", async () => {
    await renderRail();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      await moveFirst(30);
      const prompt = await screen.findByRole('dialog', { name: `${title(30)} moved` });
      fireEvent.click(within(prompt).getByRole('button', { name: "Don't ask again" }), { detail: 1 });
      expect(
        await screen.findByText('This browser is not keeping settings, so Conductia will ask again.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/You can change this in/)).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      await moveFirst(31);
      expect(await screen.findByRole('dialog', { name: `${title(31)} moved` })).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it("Don't ask again from the keyboard puts focus on the Settings link and holds the note there", async () => {
    await renderRail();
    // The live region is mounted before it has anything to say.
    const region = screen
      .getAllByRole('status')
      .find((el) => el.classList.contains('sr-only') && el.textContent === '');
    expect(region).toBeDefined();
    await moveFirst(30);
    const prompt = await screen.findByRole('dialog', { name: `${title(30)} moved` });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Enter or Space on a button clicks with detail 0.
      fireEvent.click(within(prompt).getByRole('button', { name: "Don't ask again" }), { detail: 0 });
      const link = screen.getByRole('link', { name: 'Settings › Rails' });
      // Focus moves on the next animation frame, which stays real.
      await act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
      expect(link).toHaveFocus();
      // Held while focused: still there well past the two seconds.
      act(() => vi.advanceTimersByTime(DONT_ASK_CONFIRM_MS + 300));
      expect(screen.getByRole('link', { name: 'Settings › Rails' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
    fireEvent.keyDown(screen.getByRole('link', { name: 'Settings › Rails' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/You can change this in/)).not.toBeInTheDocument());
  });

  it('removes from step detail through its confirm and the existing DELETE, then prompts', async () => {
    await renderRail();
    const detail = await openStep(28);
    fireEvent.click(within(detail).getByRole('button', { name: 'Remove', exact: true } as never));
    expect(calls((_u, init) => init?.method === 'DELETE')).toBe(0);
    fireEvent.click(within(detail).getByRole('button', { name: 'Remove step' }));
    await waitFor(() => expect(calls((_u, init) => init?.method === 'DELETE')).toBe(1));
    const prompt = await screen.findByRole('dialog', { name: `${title(28)} removed` });
    expect(within(prompt).getByText('This changes the rail for everyone on this deal.')).toBeInTheDocument();
  });

  it('never prompts and offers no Move to… or Remove… without rail editing rights', async () => {
    canEdit = false;
    dealRole = 'deal_team';
    await renderRail();
    expect(screen.queryByRole('button', { name: 'Edit rail' })).not.toBeInTheDocument();
    const detail = await openStep(28);
    expect(within(detail).queryByRole('button', { name: 'Move to…' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Remove', exact: true } as never)).not.toBeInTheDocument();
    // Only the step's own dialog: no edit prompt.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});

describe('who can change this rail and proposals', () => {
  it('states the edit right for every viewer, never "only the deal lead"', async () => {
    await renderRail();
    expect(screen.getByTestId('rail-who-can-change')).toHaveTextContent(
      'People with rail editing rights change this rail.',
    );
    expect(screen.queryByText(/only the deal lead/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose a change' })).not.toBeInTheDocument();
  });

  it('lets a non-editor propose; the deal lead tray accepts without any network write', async () => {
    canEdit = false;
    dealRole = 'deal_team';
    await renderRail();
    expect(screen.getByTestId('rail-who-can-change')).toBeInTheDocument();
    const before = writes();

    fireEvent.click(screen.getByRole('button', { name: 'Propose a change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Propose a change' });
    fireEvent.change(within(dialog).getByLabelText('Step'), { target: { value: 'uuid-30' } });
    fireEvent.change(within(dialog).getByLabelText('What should change'), { target: { value: 'Run this before 28' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Propose change' }));

    fireEvent.click(screen.getByRole('checkbox', { name: /View as deal lead/ }));
    const tray = screen.getByRole('region', { name: 'Proposed changes' });
    expect(within(tray).getByText('Run this before 28')).toBeInTheDocument();
    expect(within(tray).getByText(/Your rail stays as it is until you choose\./)).toBeInTheDocument();
    fireEvent.click(within(tray).getByRole('button', { name: 'Accept Run this before 28' }));
    expect(within(tray).getByText('Accepted')).toBeInTheDocument();
    expect(writes()).toBe(before);
  });

  /** A non-editor proposes one change, then opens the deal lead's tray. */
  async function proposeAndOpenTray(text: string) {
    canEdit = false;
    dealRole = 'deal_team';
    await renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Propose a change' }));
    const dialog = await screen.findByRole('dialog', { name: 'Propose a change' });
    fireEvent.change(within(dialog).getByLabelText('Step'), { target: { value: 'uuid-30' } });
    fireEvent.change(within(dialog).getByLabelText('What should change'), { target: { value: text } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Propose change' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /View as deal lead/ }));
    return screen.getByRole('region', { name: 'Proposed changes' });
  }

  it("the tray's Reset clears every proposal, accepted ones included, and writes nothing", async () => {
    const tray = await proposeAndOpenTray('Run this before 28');
    const before = writes();
    fireEvent.click(within(tray).getByRole('button', { name: 'Accept Run this before 28' }));
    expect(within(tray).getByText('Accepted')).toBeInTheDocument();

    fireEvent.click(within(tray).getByRole('button', { name: 'Reset' }));
    expect(within(tray).queryAllByRole('listitem')).toHaveLength(0);
    expect(within(tray).queryByText('Run this before 28')).not.toBeInTheDocument();
    expect(within(tray).queryByText('Accepted')).not.toBeInTheDocument();
    expect(within(tray).getByText(/No proposals yet\./)).toBeInTheDocument();
    expect(writes()).toBe(before);
  });

  it('Discard marks the proposal Discarded, keeps it listed and writes nothing', async () => {
    const tray = await proposeAndOpenTray('Run this before 28');
    const before = writes();
    fireEvent.click(within(tray).getByRole('button', { name: 'Discard Run this before 28' }));
    expect(within(tray).getByText('Discarded')).toBeInTheDocument();
    expect(within(tray).getByText('Run this before 28')).toBeInTheDocument();
    expect(within(tray).queryByRole('button', { name: 'Accept Run this before 28' })).not.toBeInTheDocument();
    expect(writes()).toBe(before);
  });

  it('Undo on a discarded proposal puts it back to undecided and writes nothing', async () => {
    const tray = await proposeAndOpenTray('Run this before 28');
    const before = writes();
    fireEvent.click(within(tray).getByRole('button', { name: 'Discard Run this before 28' }));
    fireEvent.click(within(tray).getByRole('button', { name: 'Undo Run this before 28' }));
    expect(within(tray).queryByText('Discarded')).not.toBeInTheDocument();
    expect(within(tray).getByRole('button', { name: 'Accept Run this before 28' })).toBeInTheDocument();
    expect(within(tray).getByRole('button', { name: 'Discard Run this before 28' })).toBeInTheDocument();
    expect(writes()).toBe(before);
  });
});

describe('dependency view and step dates', () => {
  it('shows no "Waiting on" until a link is drawn, and Reset clears it', async () => {
    await renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Dependency' }));
    const view = screen.getByRole('region', { name: 'Dependencies' });
    expect(within(view).queryByText(/^Waiting on \d/)).not.toBeInTheDocument();
    const before = writes();

    const form = within(view).getByRole('form', { name: 'Draw a link' });
    fireEvent.change(within(form).getByLabelText('Step'), { target: { value: 'uuid-28' } });
    fireEvent.change(within(form).getByLabelText('Waits on'), { target: { value: 'uuid-26' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Draw link' }));
    expect(within(view).getByText(`Waiting on 01 · ${title(26)} · Hard`)).toBeInTheDocument();

    // A link to a done step is satisfied: no "Waiting on".
    fireEvent.change(within(form).getByLabelText('Step'), { target: { value: 'uuid-29' } });
    fireEvent.change(within(form).getByLabelText('Waits on'), { target: { value: 'uuid-27' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Draw link' }));
    expect(within(view).getByText(`After 02 · ${title(27)} · Hard · Done`)).toBeInTheDocument();
    expect(writes()).toBe(before);

    fireEvent.click(within(view).getByRole('button', { name: 'Reset' }));
    expect(within(view).queryByText(/^Waiting on \d/)).not.toBeInTheDocument();
  });

  it('refuses a three-step loop, offers no done step as the waiting side, and holds bad dates', async () => {
    await renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Dependency' }));
    const view = screen.getByRole('region', { name: 'Dependencies' });
    const form = within(view).getByRole('form', { name: 'Draw a link' });
    const before = writes();

    // The done step 27 can be waited on, but never waits.
    const waiting = within(form).getByLabelText('Step') as HTMLSelectElement;
    expect(Array.from(waiting.options).map((o) => o.value)).not.toContain('uuid-27');
    expect(Array.from((within(form).getByLabelText('Waits on') as HTMLSelectElement).options).map((o) => o.value)).toContain('uuid-27');

    const draw = (to: string, from: string) => {
      fireEvent.change(within(form).getByLabelText('Step'), { target: { value: to } });
      fireEvent.change(within(form).getByLabelText('Waits on'), { target: { value: from } });
      fireEvent.click(within(form).getByRole('button', { name: 'Draw link' }));
    };
    draw('uuid-28', 'uuid-29');
    draw('uuid-29', 'uuid-30');
    draw('uuid-30', 'uuid-28');
    expect(within(form).getByRole('alert')).toHaveTextContent('That would make these steps wait on each other in a loop.');
    expect(within(view).queryByText(`Waiting on 03 · ${title(28)} · Hard`)).not.toBeInTheDocument();

    fireEvent.click(within(view).getByRole('button', { name: `Set dates for ${title(28)}` }));
    const dialog = await screen.findByRole('dialog', { name: title(28) });
    fireEvent.change(within(dialog).getByLabelText('Target date'), { target: { value: '2026-11-20' } });
    fireEvent.change(within(dialog).getByLabelText('Drop-dead date'), { target: { value: '2026-11-10' } });
    const set = within(dialog).getByRole('button', { name: 'Set dates' });
    expect(set).toBeDisabled();
    expect(set).toHaveAccessibleDescription('The drop-dead date cannot be before the target date.');
    fireEvent.change(within(dialog).getByLabelText('Drop-dead date'), { target: { value: '2026-11-30' } });
    expect(within(dialog).getByRole('button', { name: 'Set dates' })).toBeEnabled();
    expect(writes()).toBe(before);
  });

  it('sets a Preview date that shows beside the target close, and Reset removes it', async () => {
    await renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Dependency' }));
    const view = screen.getByRole('region', { name: 'Dependencies' });
    fireEvent.click(within(view).getByRole('button', { name: `Set dates for ${title(28)}` }));
    const dialog = await screen.findByRole('dialog', { name: title(28) });
    fireEvent.change(within(dialog).getByLabelText('Drop-dead date'), { target: { value: '2026-11-20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set dates' }));

    const beside = screen.getByTestId('rail-preview-date');
    expect(beside).toHaveTextContent(`Drop-dead Nov 20, 2026 · ${title(28)}`);
    expect(within(beside).getByText('Preview')).toBeInTheDocument();

    fireEvent.click(within(view).getByRole('button', { name: 'Reset' }));
    expect(screen.queryByTestId('rail-preview-date')).not.toBeInTheDocument();
  });
});

describe('reorder and dependency Preview edge cases', () => {
  it('Move to… offers no place ahead of a done or required step', async () => {
    await renderRail();
    const dialog = await openMoveDialog(30);
    const options = within(dialog)
      .getAllByRole('radio')
      .map((r) => r.closest('label')?.textContent ?? '');
    // 27 is done, so nothing goes before it (or before 26 above it).
    expect(options[0]).toBe(`After 02 · ${title(27)}`);
    expect(options.some((o) => o.startsWith('First in'))).toBe(false);
    expect(options.some((o) => o.startsWith(`After 01 ·`))).toBe(false);
    expect(within(dialog).getByText('Here now')).toBeInTheDocument();
  });

  it('moving a step back to its saved place clears its Preview marks', async () => {
    await renderRail();
    await moveFirst(30);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep in this browser' }));
    expect(within(card(30)).getByText('Moved in this browser')).toBeInTheDocument();

    const dialog = await openMoveDialog(30);
    fireEvent.click(within(dialog).getByRole('radio', { name: `After 04 · ${title(29)}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move step' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep in this browser' }));
    await zoomOut();

    expect(stackOrder()[4]).toContain(title(30));
    expect(screen.queryByText('Moved in this browser')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing here is saved to the deal/)).not.toBeInTheDocument();
  });

  it('removing the only moved step drops the Preview: no banner and no Reset', async () => {
    await renderRail();
    await moveFirst(30);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep in this browser' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText(/Nothing here is saved to the deal/)).toBeInTheDocument();

    await removeFromDetail(30);
    const prompt = await screen.findByRole('dialog', { name: `${title(30)} removed` });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Apply to this deal' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${title(30)} removed` })).not.toBeInTheDocument());
    await zoomOut();
    await waitFor(() => expect(screen.queryByTestId('step-uuid-30')).not.toBeInTheDocument());
    expect(screen.queryByText(/Nothing here is saved to the deal/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('a link drawn from a skipped step is satisfied and says Skipped', async () => {
    statusOf = { 28: 'skipped' };
    await renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Dependency' }));
    const view = screen.getByRole('region', { name: 'Dependencies' });
    const form = within(view).getByRole('form', { name: 'Draw a link' });
    fireEvent.change(within(form).getByLabelText('Step'), { target: { value: 'uuid-29' } });
    fireEvent.change(within(form).getByLabelText('Waits on'), { target: { value: 'uuid-28' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Draw link' }));
    expect(within(view).getByText(`After 03 · ${title(28)} · Hard · Skipped`)).toBeInTheDocument();
    expect(within(view).queryByText(/^Waiting on \d/)).not.toBeInTheDocument();
  });

  it('lets a person pick Sequential, Dependency or Timeline, and keeps the choice here', async () => {
    await renderRail();
    expect(screen.getByRole('tab', { name: 'Sequential' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /^Show:/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    expect(within(timeline).getByRole('button', { name: new RegExp(`Set dates for ${title(28)}, no dates yet`) })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Rail overview' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('conductia.pref.railLayout')).toBe('timeline');

    fireEvent.click(screen.getByRole('tab', { name: 'Dependency' }));
    expect(within(screen.getByRole('region', { name: 'Dependencies' })).getByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
  });

  it('draws a bar on the timeline from the dates a person sets', async () => {
    await renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    const timeline = screen.getByRole('region', { name: 'Timeline' });
    fireEvent.click(within(timeline).getByRole('button', { name: new RegExp(`Set dates for ${title(28)}, no dates yet`) }));
    const dialog = await screen.findByRole('dialog', { name: title(28) });
    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '2026-11-25' } });
    fireEvent.change(within(dialog).getByLabelText('Target date'), { target: { value: '2026-11-20' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('The start date cannot be after the target date.');
    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '2026-11-10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set dates' }));
    await waitFor(() => expect(within(timeline).queryByRole('button', { name: new RegExp(`Set dates for ${title(28)}, no dates yet`) })).not.toBeInTheDocument());
    const bar = within(timeline).getByRole('button', { name: new RegExp(`^Set dates for ${title(28)}, `) });
    // Ten days from start to target, not the single mark a target alone gets.
    expect(parseFloat(bar.style.width)).toBeGreaterThan(14);
  });

  it('the Sequential tab controls a panel that exists', async () => {
    await renderRail();
    const tab = screen.getByRole('tab', { name: 'Sequential' });
    const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(within(panel as HTMLElement).getByRole('region', { name: 'Rail overview' })).toBeInTheDocument();
  });

  it('the dates dialog carries the shared Preview chip', async () => {
    await renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Dependency' }));
    const view = screen.getByRole('region', { name: 'Dependencies' });
    fireEvent.click(within(view).getByRole('button', { name: `Set dates for ${title(28)}` }));
    const dialog = await screen.findByRole('dialog', { name: title(28) });
    expect(dialog.querySelector('[data-preview="chip"]')).not.toBeNull();
    expect(within(dialog).getByText('These dates show in this browser only. Nothing is saved to the deal.')).toBeInTheDocument();
  });
});
