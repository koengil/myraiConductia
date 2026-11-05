import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  bookPhases,
  consoleStep,
  consoleTasks,
  currentPhaseIndex,
  dealDay,
  nextPhaseName,
} from '../src/lib/book/dealStatus';
import { MOCK_DEAL_CONSOLE_BY_PHASE, type ConsolePhaseIndex } from '../src/lib/mock/scale';
import { MOCK_DEAL_CONSOLE_BY_STEP } from '../src/lib/mock/consoleTasks';
import { MVP_DEAL_RAIL, orderedSteps } from '../src/lib/rail/dealRail';
import type { FixtureDeal } from '../src/lib/rail/deals';

/*
 * The Book deal view (#191 slice 2, deck slide 10).
 *
 * Contracts under test:
 *   1. dealStatus rolls the deal's REAL cursor step up into the canonical
 *      5 phases (done/current/todo), with Day N and the next phase name.
 *   2. The Deal Console shows the task set of the STEP the deal is on
 *      (Storm's Aug 24 feedback: a closing-stage deal was showing diligence
 *      tasks; each step carries its own tasks) — fixture sets keyed by step
 *      id, picked via the deal's real cursor, each task carrying done /
 *      not-done sub-items; the phase set is only the off-rail fallback.
 *   3. BookDeal renders the phase list and the Deal Console with source
 *      chips and statuses, under a Preview banner that calls the rows
 *      samples, never under the deal's real phase or step.
 */

let activeDeal: FixtureDeal;
const reloadMock = vi.fn();

const deal = (over: Partial<FixtureDeal>): FixtureDeal =>
  ({
    id: 'mesa-id',
    codename: 'Mesa',
    code: 'MESAX-2026-413',
    target: 'Mesa Analytics',
    sector: 'Software',
    status: 'Diligence',
    cursorStepId: 'p4-s48',
    entryStepSeq: 48,
    gate0Complete: true,
    dealRole: 'md',
    createdAt: new Date(Date.now() - 41 * 86_400_000).toISOString(),
    ...over,
  }) as unknown as FixtureDeal;

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'mesa-id' }),
}));
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  // Keep the REAL resolveActiveDeal (the resolution seam under test rides
  // it); mock only the hook.
  const actual = await importOriginal<typeof import('../src/lib/deals/useDeals')>();
  return {
    ...actual,
    useDeals: () => ({ state: { status: 'ready' }, deals: [activeDeal], reload: reloadMock }),
  };
});
let apiCreateFlag = false;
let externalViewer = false;
let userStatus: 'ready' | 'loading' | 'error' = 'ready';
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({
    state: userStatus === 'ready' ? { status: 'ready', data: { user: { is_external: externalViewer } } } : { status: userStatus, email: null },
  }),
}));
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => (key === 'gate0_api_create' ? apiCreateFlag : false),
}));

import { BookDeal, CONSOLE_FOOTER, CONSOLE_SAMPLE_MESSAGE } from '../src/components/book/BookDeal';

beforeEach(() => {
  activeDeal = deal({});
  apiCreateFlag = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('dealStatus roll-up', () => {
  it('derives the current phase from the cursor step; earlier done, later todo', () => {
    const d = deal({ cursorStepId: 'p4-s48' });
    expect(currentPhaseIndex(d)).toBe(4);
    const phases = bookPhases(d);
    expect(phases.map((p) => p.state)).toEqual(['done', 'done', 'done', 'current', 'todo']);
  });

  it('Day N counts whole days since creation, minimum 1', () => {
    expect(dealDay(deal({}))).toBe(42);
    expect(dealDay(deal({ createdAt: new Date().toISOString() }))).toBe(1);
    expect(dealDay(deal({ createdAt: undefined }))).toBe(1);
  });

  it('names the next phase; the last phase has none', () => {
    expect(nextPhaseName(deal({ cursorStepId: 'p4-s48' }))).toContain('Signing');
    expect(nextPhaseName(deal({ cursorStepId: 'p5-s60' }))).toBeNull();
  });
});

describe('console tasks by active step (phase set as the off-rail fallback)', () => {
  it('every phase on the MVP rail has a task set, every task has sub-items', () => {
    // Derived from the rail, not a hardcoded 1..5: a re-cut census that adds
    // or renumbers a phase must fail here, not paint an empty console.
    expect(MVP_DEAL_RAIL.length).toBeGreaterThan(0);
    for (const phase of MVP_DEAL_RAIL) {
      const set = MOCK_DEAL_CONSOLE_BY_PHASE[phase.index as ConsolePhaseIndex];
      expect(set, `phase ${phase.index}`).toBeDefined();
      expect(set.length).toBeGreaterThan(0);
      for (const task of set) expect(task.subtasks.length).toBeGreaterThan(0);
    }
  });

  it('every step on the MVP rail carries its own task set, every task has sub-items (per-step slice)', () => {
    const steps = orderedSteps(MVP_DEAL_RAIL);
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      const set = MOCK_DEAL_CONSOLE_BY_STEP[step.id];
      expect(set, `step ${step.id} ${step.title}`).toBeDefined();
      expect(set.length, step.id).toBeGreaterThan(0);
      for (const task of set) expect(task.subtasks.length, `${step.id}: ${task.title}`).toBeGreaterThan(0);
    }
    // No orphan sets: a key that is not a rail step is a typo, not data.
    const ids = new Set(steps.map((s) => s.id));
    for (const key of Object.keys(MOCK_DEAL_CONSOLE_BY_STEP)) expect(ids.has(key), key).toBe(true);
  });

  it('picks the set for the STEP the cursor is on (not just the phase)', () => {
    expect(consoleTasks(deal({ cursorStepId: 'p5-s57' }))).toBe(MOCK_DEAL_CONSOLE_BY_STEP['p5-s57']);
    expect(consoleTasks(deal({ cursorStepId: 'p2-s33' }))).toBe(MOCK_DEAL_CONSOLE_BY_STEP['p2-s33']);
    expect(consoleTasks(deal({ cursorStepId: 'p3-s39' }))).not.toBe(consoleTasks(deal({ cursorStepId: 'p3-s45' })));
    expect(consoleStep(deal({ cursorStepId: 'p5-s57' }))?.title).toBe('Closing Checklist');
  });

  it('an off-rail cursor falls back to the PHASE set (phase 1 when unknown), never a blank console', () => {
    expect(consoleTasks(deal({ cursorStepId: 'nope' }))).toBe(MOCK_DEAL_CONSOLE_BY_PHASE[1]);
    expect(consoleStep(deal({ cursorStepId: 'nope' }))).toBeNull();
  });
});

describe('BookDeal', () => {
  it('renders the header line, the 5 phases, and the Preview chip on the sample tasks', () => {
    render(<BookDeal />);
    expect(screen.getByText('Mesa')).toBeInTheDocument();
    expect(screen.getByText(/Day 42 · in Diligence, LOI & Definitive Docs/)).toBeInTheDocument();
    expect(screen.getByText('Origination, Qualification & Mandate')).toBeInTheDocument();
    expect(screen.queryByText(/fixture/i)).toBeNull();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('the Deal Console carries source chips, statuses, and the routing line', () => {
    render(<BookDeal />);
    expect(screen.getByText('Buyer C diligence Q&A (14 responses)')).toBeInTheDocument();
    expect(screen.getAllByText('Agent').length).toBeGreaterThan(0);
    expect(screen.getByText('MD review')).toBeInTheDocument();
    expect(screen.getByText(CONSOLE_FOOTER)).toBeInTheDocument();
  });

  it('the sample tasks sit under a Preview banner, never under the deal\'s real step', () => {
    // Summit's position: the Client NDA step. Sample rows must never read as
    // this deal's work ("SVP · In progress").
    activeDeal = deal({ cursorStepId: 'p1-s12', status: 'Origination' });
    const stepName = consoleStep(activeDeal)?.title;
    expect(stepName).toBe('Client NDA Workflow');
    render(<BookDeal />);
    const consoleRegion = screen.getByRole('heading', { name: /Deal console/ }).closest('section') as HTMLElement;
    const text = consoleRegion.textContent ?? '';
    expect(text).toContain(CONSOLE_SAMPLE_MESSAGE);
    expect(text).toMatch(/Sample/);
    expect(text).toContain("not this deal's");
    expect(consoleRegion.querySelector('[data-preview="banner"]')).not.toBeNull();
    for (const banned of ['SVP', 'In progress', 'logged', 'Client NDA Workflow']) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it('no sample task set carries "logged" or an off-glossary label', () => {
    // The per-step sets and the per-phase fallback sets alike.
    const sets = [
      ...Object.entries(MOCK_DEAL_CONSOLE_BY_STEP),
      ...Object.entries(MOCK_DEAL_CONSOLE_BY_PHASE).map(([phase, set]) => [`phase ${phase}`, set] as const),
    ];
    for (const [stepId, set] of sets) {
      for (const task of set) {
        expect(task.title, stepId).not.toMatch(/logged/i);
        for (const item of task.subtasks) expect(item.title, `${stepId}: ${item.title}`).not.toMatch(/logged/i);
      }
    }
  });

  it('a deal not in the viewer\'s list is the shared not-on-deal state, never placeholder facts under the raw code', () => {
    apiCreateFlag = true;
    activeDeal = deal({ id: 'other-id', code: 'OTHER-2026-001' });
    render(<BookDeal />);
    expect(screen.getByText('You are not on this deal.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Conductor Center' })).toHaveAttribute('href', '/projects');
    // Exactly one h1, the page title, and never the deal's code (S6R5-R1 M2).
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('Book');
    expect(headings[0]).not.toHaveTextContent('OTHER-2026-001');
    expect(headings[0]).not.toHaveTextContent('Mesa');
    expect(screen.queryByText('OTHER-2026-001')).toBeNull();
    expect(screen.queryByText('mesa-id')).toBeNull();
    expect(screen.queryByText(/^Target close:/)).toBeNull();
    expect(screen.queryByText(/No deal here yet/)).toBeNull();
  });

  it('the Book deal page never prints the deal code', () => {
    activeDeal = deal({ code: 'SUMMIT-2026-003', codename: 'Project Summit' });
    render(<BookDeal />);
    expect(screen.getByRole('heading', { level: 1, name: 'Project Summit' })).toBeInTheDocument();
    expect((document.body.textContent ?? '').match(/SUMMIT-2026-003/g) ?? []).toHaveLength(0);
  });

  it('shows THAT step\'s tasks on the console', () => {
    render(<BookDeal />);
    expect(screen.queryByText(/Step \d+ · LOI Review/)).not.toBeInTheDocument();
    for (const task of MOCK_DEAL_CONSOLE_BY_STEP['p4-s48']) {
      expect(screen.getByText(task.title)).toBeInTheDocument();
    }
    // A same-phase, different-step task is NOT on this console.
    expect(screen.queryByText('Process letter and LOI form')).not.toBeInTheDocument();
    expect(screen.queryByText('Closing checklist (31 items)')).not.toBeInTheDocument();
  });

  it('a closing-stage deal shows closing tasks, not diligence ones (the demo bug)', () => {
    activeDeal = deal({ cursorStepId: 'p5-s57', status: 'Closing' });
    render(<BookDeal />);
    expect(screen.getByText('Closing checklist (31 items)')).toBeInTheDocument();
    expect(screen.queryByText('Buyer C diligence Q&A (14 responses)')).not.toBeInTheDocument();
  });

  it('each task lists its sub-items with a spoken done / open state and a count', () => {
    render(<BookDeal />);
    const first = MOCK_DEAL_CONSOLE_BY_STEP['p4-s48'][0];
    const done = first.subtasks.filter((s) => s.done).length;
    expect(screen.getByText(first.subtasks[0].title)).toBeInTheDocument();
    expect(screen.getAllByText('Done:').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Open:').length).toBeGreaterThan(0);
    expect(
      screen.getByText(`${done} of ${first.subtasks.length} done`),
    ).toBeInTheDocument();
  });

  it('shows the target close date when the deal has one, and "Not set" when it does not', () => {
    activeDeal = deal({ targetCloseDate: '2026-10-09' });
    render(<BookDeal />);
    expect(screen.getByText(/Target close/)).toBeInTheDocument();
    expect(screen.getByText('Oct 9, 2026')).toBeInTheDocument();
    cleanup();
    activeDeal = deal({ targetCloseDate: null, lifecycleCategory: 'live' });
    render(<BookDeal />);
    // Close date, fee and schedule each say "Not set" when the deal has none;
    // a real deal always has a category, so that line never does.
    expect(screen.getAllByText("Not set")).toHaveLength(3);
  });

  it('shows the fee and schedule status when the deal has them (graduated fields, not fixture)', () => {
    activeDeal = deal({ feeUsd: 5_100_000, scheduleStatus: 'ahead' });
    render(<BookDeal />);
    expect(screen.getByText(/^Fee:/)).toBeInTheDocument();
    expect(screen.getByText('$5.1M')).toBeInTheDocument();
    expect(screen.getByText('Ahead')).toBeInTheDocument();
  });

  it('with the API on, the MD can set the fee and the schedule status, each as its own PATCH', async () => {
    apiCreateFlag = true;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deal: { code: 'MESAX-2026-413' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookDeal />);
    fireEvent.change(screen.getByLabelText('Fee in US dollars'), { target: { value: '5100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save fee' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      feeUsd: 5100000,
    });
    fireEvent.change(screen.getByLabelText('Schedule status'), { target: { value: 'late' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule status' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({
      scheduleStatus: 'late',
    });
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(2));
  });

  it('shows the lifecycle category and, with the API on, the MD can move the deal', async () => {
    apiCreateFlag = true;
    activeDeal = deal({ lifecycleCategory: 'pitch' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ deal: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookDeal />);
    // 'Pitches' also appears as a <select> option; assert the displayed value line.
    expect(screen.getByText(/^Category:/).textContent).toContain('Pitches');
    fireEvent.change(screen.getByLabelText('Lifecycle category'), { target: { value: 'mandate_hold' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle category' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({
      lifecycleCategory: 'mandate_hold',
    });
  });

  it('a member who is not the deal MD sees fee and schedule read-only even with the API on', () => {
    apiCreateFlag = true;
    activeDeal = deal({ dealRole: 'deal_team', feeUsd: 5_100_000, scheduleStatus: 'ahead' });
    render(<BookDeal />);
    expect(screen.queryByLabelText('Fee in US dollars')).toBeNull();
    expect(screen.queryByLabelText('Schedule status')).toBeNull();
    expect(screen.queryByLabelText('Lifecycle category')).toBeNull();
  });

  it('with the API on, the MD can set the target close date; the deal list reloads after the save', async () => {
    apiCreateFlag = true;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deal: { code: 'MESAX-2026-413', targetCloseDate: '2026-11-20' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookDeal />);
    const input = screen.getByLabelText('Target close date') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-11-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save target close' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/deals/mesa-id');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ targetCloseDate: '2026-11-20' });
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
  });

  it('a Save at the stored value stays in view, disabled, and names its reason', () => {
    apiCreateFlag = true;
    activeDeal = deal({ targetCloseDate: '2026-11-20', lifecycleCategory: 'live' });
    render(<BookDeal />);
    const save = screen.getByRole('button', { name: 'Save target close' });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('No change to save.');
    const reason = document.getElementById(save.getAttribute('aria-describedby')!);
    expect(reason).toBeVisible();
    expect(reason).toHaveTextContent('No change to save.');
    // Every Book field's Save carries the same reason at its stored value.
    for (const name of ['Save fee', 'Save schedule status', 'Save lifecycle category']) {
      expect(screen.getByRole('button', { name })).toHaveAccessibleDescription('No change to save.');
    }

    fireEvent.change(screen.getByLabelText('Target close date'), { target: { value: '2026-12-01' } });
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute('aria-describedby');
    expect(screen.getAllByText('No change to save.')).toHaveLength(3);
  });

  it('keeps the "Saved." receipt when the refreshed deal list arrives', async () => {
    apiCreateFlag = true;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ deal: { code: 'MESAX-2026-413', targetCloseDate: '2026-11-20' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<BookDeal />);
    fireEvent.change(screen.getByLabelText('Target close date'), {
      target: { value: '2026-11-20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save target close' }));
    await screen.findByText('Saved.');

    activeDeal = deal({ targetCloseDate: '2026-11-20' });
    rerender(<BookDeal />);

    expect(screen.getByText('Saved.')).toBeInTheDocument();
    expect(screen.getByText(/^Target close:/).textContent).toContain('Nov 20, 2026');
    expect((screen.getByLabelText('Target close date') as HTMLInputElement).value).toBe(
      '2026-11-20',
    );
    expect(screen.getByRole('button', { name: 'Save target close' })).toBeDisabled();
  });

  it('a member who is not the deal MD sees the date read-only even with the API on', () => {
    apiCreateFlag = true;
    activeDeal = deal({ dealRole: 'deal_team', targetCloseDate: '2026-10-09' });
    render(<BookDeal />);
    expect(screen.getByText('Oct 9, 2026')).toBeInTheDocument();
    expect(screen.queryByLabelText('Target close date')).toBeNull();
  });

  it('with the API off, the date is read-only (fixture demo cannot persist it)', () => {
    render(<BookDeal />);
    expect(screen.queryByLabelText('Target close date')).toBeNull();
  });

  it('hides the Deal Folder link from a viewer the shell keeps out of it', () => {
    externalViewer = true;
    try {
      render(<BookDeal />);
      expect(screen.queryByRole('link', { name: 'Deal Folder' })).toBeNull();
    } finally {
      externalViewer = false;
    }
  });

  it('shows no Deal Folder link while the viewer is loading or errored', () => {
    for (const status of ['loading', 'error'] as const) {
      userStatus = status;
      try {
        const { unmount } = render(<BookDeal />);
        expect(screen.queryByRole('link', { name: 'Deal Folder' })).toBeNull();
        expect(screen.getByRole('link', { name: 'Open the rail' })).toBeInTheDocument();
        unmount();
      } finally {
        userStatus = 'ready';
      }
    }
  });

  it('links to the rail and the deal folder of the SAME deal', () => {
    render(<BookDeal />);
    expect(screen.getByRole('link', { name: 'Open the rail' })).toHaveAttribute('href', '/projects/mesa-id/rail');
    expect(screen.getByRole('link', { name: 'Deal Folder' })).toHaveAttribute('href', '/projects/mesa-id/deal-folder');
  });
});
