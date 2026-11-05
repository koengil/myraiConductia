import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { formatCloseDate, formatFee, toBookRows } from '../src/lib/book/data';
import type { FixtureDeal } from '../src/lib/rail/deals';

/*
 * The Book home preview (#191, slice 1) — Storm's slide 9 as a live view.
 *
 * Contracts under test:
 *   1. toBookRows joins live deals with the mock-scale fixtures by codename:
 *      fixture deals carry close/fee/schedule/category; unknown deals render
 *      honestly empty and sink below dated rows.
 *   2. BookHome: Live Deals table + category groups in Storm's order (the
 *      Today's Tasks panel is retired until the task model graduates).
 *   3. BankHome: flag OFF = Command Center only (no switcher); flag ON =
 *      Console/Book switcher, choice persisted in localStorage.
 */

const deal = (over: Partial<FixtureDeal>): FixtureDeal =>
  ({
    id: 'code-1',
    codename: 'Placeholder',
    code: 'PLACE-2026-001',
    target: 'Target Co',
    sector: 'Software',
    status: 'Marketing',
    cursorStepId: 'p1-s8',
    entryStepSeq: 8,
    gate0Complete: true,
    dealRole: 'md',
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  }) as unknown as FixtureDeal;

const DEALS: FixtureDeal[] = [
  deal({ id: 'mesa-id', codename: 'Mesa', code: 'MESAX-2026-413', status: 'Signing', targetCloseDate: '2026-10-09', feeUsd: 5_100_000, scheduleStatus: 'ahead' }),
  deal({ id: 'vega-id', codename: 'Vega', code: 'VEGAX-2026-440', status: 'Origination', targetCloseDate: '2027-08-20', lifecycleCategory: 'pitch' }),
  deal({ id: 'atlas-id', codename: 'Atlas', code: 'ATLAS-2025-001', status: 'Closed', lifecycleCategory: 'closed' }),
  deal({ id: 'sparrow-id', codename: 'Sparrow', code: 'SPARR-2026-965', status: 'Diligence' }),
];

// jsdom has no App Router; the row-level navigation needs a mounted router.
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));
// Typed via the hook itself so a union reshape breaks HERE at compile time —
// the old bare-string mock silently drifted from production for months.
type DealsState = import('@/lib/deals/useDeals').DealsState;
let dealsState: DealsState = { status: 'ready', deals: [] };
let dealsList: FixtureDeal[] = [];
vi.mock('@/lib/deals/useDeals', () => ({
  useDeals: () => ({ state: dealsState, deals: dealsList, reload: () => {} }),
}));
vi.mock('@/components/workspace/CommandCenter', () => ({
  CommandCenter: () => <div data-testid="command-center">console view</div>,
}));
// BankHome reads the flag from the layout's FlagsProvider; pin it per test.
let bookViewFlag = false;
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => (key === 'book_view' ? bookViewFlag : false),
}));

import { BookHome } from '../src/components/book/BookHome';
import { BankHome } from '../src/components/book/BankHome';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })));
  localStorage.clear();
  dealsState = { status: 'ready', deals: [] };
  dealsList = DEALS;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('toBookRows', () => {
  it('joins fixtures by codename and leaves unknown deals honestly empty', () => {
    const rows = toBookRows(DEALS);
    const mesa = rows.find((r) => r.codename === 'Mesa')!;
    expect(mesa.category).toBe('live');
    // Close date, fee and schedule are the deal's OWN fields now (graduated); Mesa carries them.
    expect(mesa.closeDate).toBe('2026-10-09');
    expect(mesa.feeUsd).toBe(5_100_000);
    expect(mesa.scheduleStatus).toBe('ahead');

    const vega = rows.find((r) => r.codename === 'Vega')!;
    expect(vega.category).toBe('pitch');

    const sparrow = rows.find((r) => r.codename === 'Sparrow')!;
    expect(sparrow.closeDate).toBeNull();
    expect(sparrow.feeUsd).toBeNull();
  });

  it('a fixture-named deal WITHOUT its own close date, fee or schedule shows none — the fixture is never consulted', () => {
    const rows = toBookRows([deal({ id: 'sable-id', codename: 'Sable', code: 'SABLE-2026-001' })]);
    expect(rows[0].closeDate).toBeNull();
    expect(rows[0].feeUsd).toBeNull();
    expect(rows[0].scheduleStatus).toBeNull();
    // Sable is a 'pitch' in the fixture; the row says 'live' because that is
    // the column default, not because the fixture was read.
    expect(rows[0].category).toBe('live');
  });

  it('sorts nearest close first; dateless rows sink to the end', () => {
    const rows = toBookRows(DEALS);
    expect(rows[0].codename).toBe('Mesa');
    expect(rows.at(-1)!.codename).toBe('Sparrow');
  });

  it('formats fee and close date in the slide vocabulary', () => {
    expect(formatFee(5_100_000)).toBe('$5.1M');
    expect(formatFee(450_000)).toBe('$450,000');
    expect(formatFee(2_500_000_000)).toBe('$2.5B');
    expect(formatFee(1_000_000_000_000)).toBe('$1.0T');
    expect(formatCloseDate('2026-10-09')).toBe('Oct 9, 2026');
  });
});

describe('BookHome', () => {
  it('no longer carries the firm AI spend, which moved to its own page', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<BookHome />);
    expect(screen.queryByText(/Firm AI spend/)).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith('/api/v1/ai-spend', expect.anything());
  });
  it('renders the Live Deals table with stage, close, status, and fee', () => {
    render(<BookHome />);
    expect(screen.getByRole('heading', { name: 'Your book' })).toBeInTheDocument();
    expect(screen.getByText('Mesa')).toBeInTheDocument();
    expect(screen.getByText('Oct 9, 2026')).toBeInTheDocument();
    expect(screen.getByText('$5.1M')).toBeInTheDocument();
    expect(screen.getByText('Ahead')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Phase' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Target close' })).toBeInTheDocument();
  });

  it('the Fee cell never clips at 390: no truncate, no nowrap, no sideways scroll', () => {
    render(<BookHome />);
    const fee = screen.getByText('$5.1M').closest('td') as HTMLElement;
    expect(fee.className).not.toMatch(/\btruncate\b/);
    expect(fee.className).not.toMatch(/(^|\s)whitespace-nowrap\b/);
    // Below sm the rows stack; the table never scrolls sideways there.
    const wrapper = fee.closest('table')?.parentElement as HTMLElement;
    expect(wrapper.className).not.toMatch(/(^|\s)overflow-x-auto\b/);
    expect(fee.closest('tr')?.className).toMatch(/max-sm:grid/);
  });

  it("groups deals by Storm's lifecycle category, in his order, skipping empty groups", () => {
    render(<BookHome />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    // Exact: Storm's order, empty groups (Prospects, Mandate hold, Terminated, Lost) absent.
    expect(headings).toEqual(['Live deals', 'Pitches', 'Closed']);
    expect(screen.getByText('Vega')).toBeInTheDocument();
    expect(screen.getByText('Atlas')).toBeInTheDocument();
  });

  it('carries no engineering copy: no fixture, live-data or conducted-to-the-day lines', () => {
    const { container } = render(<BookHome />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/fixture/i);
    expect(text).not.toContain('Every column is live data');
    expect(text).not.toContain('conducted to the day');
  });

  it('the WHOLE row navigates to the Book deal view, not just the name', () => {
    render(<BookHome />);
    // Click a non-link cell (the stage) — the row itself must navigate.
    fireEvent.click(screen.getByText('Signing'));
    expect(pushMock).toHaveBeenCalledWith('/projects/mesa-id/book');
  });

  it('while the deal list loads, the table says loading — never "no deals"', () => {
    dealsState = { status: 'loading' };
    dealsList = [];
    render(<BookHome />);
    expect(screen.getByText('Loading the book…')).toBeInTheDocument();
    expect(screen.queryByText('No live deals yet.')).toBeNull();
  });

  it("the Today's Tasks panel is GONE until the task model graduates (Aug 31 decision with Rob)", () => {
    render(<BookHome />);
    expect(screen.queryByText(/Today's tasks/)).toBeNull();
    expect(screen.queryByText('13 open')).toBeNull();
    expect(screen.queryByText(/Buyer C diligence Q&A/)).toBeNull();
  });
});

describe('BankHome (the Console/Book switcher)', () => {
  it('flag OFF: the Command Center renders with NO switcher', () => {
    bookViewFlag = false;
    render(<BankHome />);
    expect(screen.getByTestId('command-center')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'View' })).toBeNull();
  });

  it('flag ON: defaults to Console; choosing Book renders it and persists', () => {
    bookViewFlag = true;
    render(<BankHome />);
    expect(screen.getByTestId('command-center')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Console' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Book' }));
    expect(screen.getByRole('heading', { name: 'Your book' })).toBeInTheDocument();
    expect(localStorage.getItem('conductia.homeView')).toBe('book');
  });

  it('labels the control View with exactly Console and Book', () => {
    bookViewFlag = true;
    render(<BankHome />);
    const group = screen.getByRole('radiogroup', { name: 'View' });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Console' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Book' })).toBeInTheDocument();
  });

  it('keyboard: roving tabindex, arrows move choice and focus with wrap, Home/End jump', () => {
    bookViewFlag = true;
    render(<BankHome />);
    const consoleRadio = screen.getByRole('radio', { name: 'Console' });
    const bookRadio = screen.getByRole('radio', { name: 'Book' });
    expect(consoleRadio).toHaveAttribute('tabindex', '0');
    expect(bookRadio).toHaveAttribute('tabindex', '-1');

    consoleRadio.focus();
    fireEvent.keyDown(consoleRadio, { key: 'ArrowRight' });
    expect(bookRadio).toHaveAttribute('aria-checked', 'true');
    expect(bookRadio).toHaveFocus();
    expect(bookRadio).toHaveAttribute('tabindex', '0');
    expect(consoleRadio).toHaveAttribute('tabindex', '-1');
    expect(localStorage.getItem('conductia.homeView')).toBe('book');

    fireEvent.keyDown(bookRadio, { key: 'ArrowRight' });
    expect(consoleRadio).toHaveAttribute('aria-checked', 'true');
    expect(consoleRadio).toHaveFocus();

    fireEvent.keyDown(consoleRadio, { key: 'ArrowLeft' });
    expect(bookRadio).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(bookRadio, { key: 'Home' });
    expect(consoleRadio).toHaveFocus();
    fireEvent.keyDown(consoleRadio, { key: 'End' });
    expect(bookRadio).toHaveFocus();
  });

  it('a stored Book view never mounts the Console first', () => {
    bookViewFlag = true;
    localStorage.setItem('conductia.homeView', 'book');
    render(<BankHome />);
    expect(screen.queryByTestId('command-center')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your book' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Book' })).toHaveAttribute('aria-checked', 'true');
  });

  it('with storage blocked, a choice still applies for the session', () => {
    bookViewFlag = true;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<BankHome />);
    fireEvent.click(screen.getByRole('radio', { name: 'Book' }));
    expect(screen.getByRole('heading', { name: 'Your book' })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('a stored Book choice is adopted after mount', async () => {
    bookViewFlag = true;
    localStorage.setItem('conductia.homeView', 'book');
    render(<BankHome />);
    // Adoption is deferred a tick (hydration-stable first paint).
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Your book' }),
      ).toBeInTheDocument(),
    );
  });
});
