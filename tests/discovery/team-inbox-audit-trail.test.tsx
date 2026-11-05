import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  auditPageUrl,
  TEAM_INBOX_AUDIT_ERROR,
  TEAM_INBOX_AUDIT_OLDER_ERROR,
  TEAM_INBOX_AUDIT_ROUTE,
  TEAM_INBOX_AUDIT_VIEWS,
  TeamInboxAuditTrail,
} from '@/components/discovery/TeamInboxAuditTrail';
import type { TeamMailboxAuditPage, TeamMailboxAuditRow } from '@/lib/discovery/api';

const INBOX = '00000000-0000-4000-8000-0000000000a1';
const SOURCE = '00000000-0000-4000-8000-0000000000b1';
const ADDRESS = 'deals@bank.example';

let seq = 0;
function row(overrides: Partial<TeamMailboxAuditRow> & Pick<TeamMailboxAuditRow, 'action'>): TeamMailboxAuditRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    ts: '2026-10-21T10:42:00.123456+00:00',
    actorType: 'service',
    actorName: null,
    serviceIdentity: 'discovery-worker',
    subjectName: null,
    inboxId: INBOX,
    detail: { teamMailboxId: INBOX },
    ...overrides,
  };
}

const page = (rows: TeamMailboxAuditRow[], next: TeamMailboxAuditPage['next'] = null): TeamMailboxAuditPage => ({
  inboxes: [{ id: INBOX, address: ADDRESS, open: true }],
  rows,
  next,
});

/**
 * A scripted route: each GET answers the page keyed by `view|before` (before decoded), or `status` for every call.
 * A key with no page answers 500. Every requested URL is recorded, raw and parsed.
 */
function stubRoute(state: { status?: number; pages: Record<string, TeamMailboxAuditPage | number> }) {
  const calls: { raw: string; url: URL }[] = [];
  const fetchMock = vi.fn((raw: string) => {
    const url = new URL(raw, 'http://localhost');
    calls.push({ raw, url });
    if (state.status) return Promise.resolve(new Response(JSON.stringify({ error: 'x' }), { status: state.status }));
    const key = `${url.searchParams.get('view')}|${url.searchParams.get('before') ?? ''}`;
    const answer = state.pages[key];
    if (answer === undefined || typeof answer === 'number') {
      return Promise.resolve(new Response(JSON.stringify({ error: 'x' }), { status: typeof answer === 'number' ? answer : 500 }));
    }
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const shownRows = (container: HTMLElement) => container.querySelectorAll('[data-audit-row-id]');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auditPageUrl', () => {
  it('asks for a view, and encodes the cursor so the offset plus survives', () => {
    expect(auditPageUrl('access', null)).toBe(`${TEAM_INBOX_AUDIT_ROUTE}?view=access`);
    const url = auditPageUrl('reads', { ts: '2026-10-21T09:00:00.123456+00:00', id: INBOX });
    expect(url).toContain('%2B00%3A00');
    expect(url).not.toContain('+');
    expect(new URL(url, 'http://localhost').searchParams.get('before')).toBe(`2026-10-21T09:00:00.123456+00:00,${INBOX}`);
  });
});

describe('TeamInboxAuditTrail', () => {
  it('renders nothing for a viewer the route answers 404 for', async () => {
    const { fetchMock } = stubRoute({ status: 404, pages: {} });
    const { container } = render(<TeamInboxAuditTrail />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows an error when the first read fails', async () => {
    stubRoute({ status: 500, pages: {} });
    render(<TeamInboxAuditTrail />);
    expect(await screen.findByRole('alert')).toHaveTextContent(TEAM_INBOX_AUDIT_ERROR);
    expect(screen.getByRole('heading', { name: 'Team inbox audit trail' })).toBeInTheDocument();
  });

  it('shows nothing, no loading line, until the first answer', async () => {
    let answer: (res: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const { container } = render(<TeamInboxAuditTrail />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    answer(new Response(JSON.stringify({ error: 'x' }), { status: 404 }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('asks for the same view again from "Try again" after the first read fails', async () => {
    const state = { pages: { 'access|': 500 } as Record<string, TeamMailboxAuditPage | number> };
    const { calls } = stubRoute(state);
    render(<TeamInboxAuditTrail />);
    expect(await screen.findByRole('alert')).toHaveTextContent(TEAM_INBOX_AUDIT_ERROR);

    // Still failing: the error stays, and the button can be pressed again.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(TEAM_INBOX_AUDIT_ERROR);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled());

    state.pages['access|'] = page([row({ action: 'discovery.team_mailbox_connected' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Access and checks' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(calls.map((c) => `${c.url.searchParams.get('view')}|${c.url.searchParams.get('before') ?? ''}`)).toEqual([
      'access|',
      'access|',
      'access|',
    ]);
  });

  it('opens on Access and checks, with the inbox address, the verdict, the reason and the service', async () => {
    const { calls } = stubRoute({
      pages: {
        'access|': page([
          row({
            action: 'discovery.team_mailbox_checked',
            detail: { teamMailboxId: INBOX, status: 'refused', reason: 'directory_denied' },
          }),
          row({
            action: 'discovery.team_mailbox_connected',
            actorType: 'user',
            actorName: 'Storm Duncan',
            serviceIdentity: null,
          }),
        ]),
      },
    });
    const { container } = render(<TeamInboxAuditTrail />);
    const table = await screen.findByRole('table', { name: 'Access and checks' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe(TEAM_INBOX_AUDIT_ROUTE);
    expect(calls[0].url.searchParams.get('view')).toBe('access');
    expect(calls[0].url.searchParams.has('before')).toBe(false);
    expect(screen.getByRole('button', { name: 'Access and checks' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All reads' })).toHaveAttribute('aria-pressed', 'false');

    for (const header of ['Time', 'Inbox', 'Action', 'Detail', 'By']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    const [checked, connected] = Array.from(shownRows(container)) as HTMLElement[];
    expect(within(checked).getByText(ADDRESS)).toBeInTheDocument();
    expect(within(checked).getByText('Checked a team inbox address')).toBeInTheDocument();
    expect(within(checked).getByText('Refused')).toBeInTheDocument();
    expect(within(checked).getByText('Directory read not granted')).toBeInTheDocument();
    expect(within(checked).getByText('Discovery worker')).toBeInTheDocument();
    expect(within(connected).getByText('Connected a team inbox for deal discovery')).toBeInTheDocument();
    expect(within(connected).getByText('by Storm Duncan')).toBeInTheDocument();
    expect(screen.getByText('2 rows shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });

  it('shows a Google ingest-group row as a firm event under All team inboxes', async () => {
    stubRoute({
      pages: {
        'access|': page([
          row({ action: 'discovery.allowlist_drift', inboxId: null, detail: { provider: 'google', status: 'unavailable' } }),
        ]),
      },
    });
    const { container } = render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });
    const [firm] = Array.from(shownRows(container)) as HTMLElement[];
    expect(within(firm).getByText('All team inboxes')).toBeInTheDocument();
    expect(within(firm).getByText("Couldn't read the Google ingest group")).toBeInTheDocument();
    expect(within(firm).getByText('Unavailable')).toBeInTheDocument();
    expect(within(firm).queryByText(ADDRESS)).not.toBeInTheDocument();
  });

  it('switches between the three views, reading each from the route', async () => {
    const { calls } = stubRoute({
      pages: {
        'access|': page([row({ action: 'discovery.team_mailbox_connected' })]),
        'reads|': page([
          row({ action: 'discovery.reader_pass_finished', detail: { sourceId: SOURCE, status: 'complete', fetched: 0, stored: 0, excluded: 0 } }),
          row({ action: 'discovery.reader_pass_started', detail: { sourceId: SOURCE } }),
        ]),
        'reads_notable|': page([
          row({ action: 'discovery.reader_pass_finished', detail: { sourceId: SOURCE, status: 'complete', fetched: 12, stored: 9, excluded: 3 } }),
          row({ action: 'discovery.reader_pass_started', detail: { sourceId: SOURCE } }),
        ]),
      },
    });
    const { container } = render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });

    fireEvent.click(screen.getByRole('button', { name: 'All reads' }));
    await screen.findByRole('table', { name: 'All reads' });
    expect(calls.at(-1)!.url.searchParams.get('view')).toBe('reads');
    expect(screen.getByRole('button', { name: 'All reads' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Access and checks' })).toHaveAttribute('aria-pressed', 'false');
    expect(shownRows(container)).toHaveLength(2);
    expect(screen.queryByText('No finish recorded')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reads with mail or problems' }));
    await screen.findByRole('table', { name: 'Reads with mail or problems' });
    expect(calls.at(-1)!.url.searchParams.get('view')).toBe('reads_notable');
    expect(screen.getByText('12 fetched, 3 excluded by policy, 9 stored')).toBeInTheDocument();
    expect(screen.getByText('No finish recorded')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Access and checks' }));
    await screen.findByRole('table', { name: 'Access and checks' });
    expect(calls.map((c) => c.url.searchParams.get('view'))).toEqual(['access', 'reads', 'reads_notable', 'access']);
  });

  it('appends an older page on Show older, by the keyset the route gave, until there is none', async () => {
    const next = { ts: '2026-10-21T09:00:00.123456+00:00', id: '00000000-0000-4000-8000-0000000000d1' };
    const first = row({ action: 'discovery.team_mailbox_checked', detail: { teamMailboxId: INBOX, status: 'verified' } });
    const older = row({ action: 'discovery.team_mailbox_connected' });
    const { calls } = stubRoute({
      pages: {
        'access|': page([first], next),
        [`access|${next.ts},${next.id}`]: page([older, first]),
      },
    });
    const { container } = render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });
    expect(shownRows(container)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(shownRows(container)).toHaveLength(2));
    const last = calls.at(-1)!;
    expect(last.url.searchParams.get('view')).toBe('access');
    expect(last.url.searchParams.get('before')).toBe(`${next.ts},${next.id}`);
    expect(last.raw).toContain('%2B');
    // The row already shown is not shown twice; the newest stays first.
    expect(Array.from(shownRows(container)).map((r) => r.getAttribute('data-audit-row-id'))).toEqual([first.id, older.id]);
    expect(screen.getByText('2 rows shown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older' })).not.toBeInTheDocument();
  });

  it('keeps the rows it has when an older page fails, and says so', async () => {
    const next = { ts: '2026-10-21T09:00:00+00:00', id: '00000000-0000-4000-8000-0000000000d2' };
    stubRoute({ pages: { 'access|': page([row({ action: 'discovery.team_mailbox_connected' })], next) } });
    const { container } = render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });

    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(TEAM_INBOX_AUDIT_OLDER_ERROR);
    expect(shownRows(container)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show older' })).toBeEnabled();
  });

  it('keeps the views when one fails to load, and reads another', async () => {
    stubRoute({
      pages: {
        'access|': page([row({ action: 'discovery.team_mailbox_connected' })]),
        'reads|': 500,
      },
    });
    render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });

    fireEvent.click(screen.getByRole('button', { name: 'All reads' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(TEAM_INBOX_AUDIT_ERROR);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Access and checks' }));
    expect(await screen.findByRole('table', { name: 'Access and checks' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reads a view that failed again from "Try again"', async () => {
    const state = {
      pages: {
        'access|': page([row({ action: 'discovery.team_mailbox_connected' })]),
        'reads|': 500,
      } as Record<string, TeamMailboxAuditPage | number>,
    };
    stubRoute(state);
    render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });
    fireEvent.click(screen.getByRole('button', { name: 'All reads' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(TEAM_INBOX_AUDIT_ERROR);

    state.pages['reads|'] = page([row({ action: 'discovery.reader_pass_started', detail: { sourceId: SOURCE } })]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'All reads' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hides itself when a later read answers 404', async () => {
    stubRoute({ pages: { 'access|': page([row({ action: 'discovery.team_mailbox_connected' })]), 'reads|': 404 } });
    const { container } = render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });
    fireEvent.click(screen.getByRole('button', { name: 'All reads' }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('says so when a view holds no rows', async () => {
    stubRoute({ pages: { 'access|': page([]) } });
    render(<TeamInboxAuditTrail />);
    expect(await screen.findByText(TEAM_INBOX_AUDIT_VIEWS[0].empty)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('writes no em dash in any copy', async () => {
    for (const v of TEAM_INBOX_AUDIT_VIEWS) {
      expect(v.label).not.toContain('—');
      expect(v.empty).not.toContain('—');
    }
    stubRoute({
      pages: {
        'access|': page([
          row({ action: 'discovery.team_mailbox_checked', detail: { teamMailboxId: INBOX, status: 'refused', reason: 'alias' } }),
          row({ action: 'discovery.team_mailbox_member_removed', serviceIdentity: 'team-mailbox', subjectName: 'Alex Moreno', detail: { teamMailboxId: INBOX, reason: 'seat_lost' } }),
          row({ action: 'discovery.mailbox_refused', serviceIdentity: 'rehearsal-probe', detail: { teamMailboxId: INBOX, reason: 'team_mailbox_unverified' } }),
        ]),
      },
    });
    const { container } = render(<TeamInboxAuditTrail />);
    await screen.findByRole('table', { name: 'Access and checks' });
    expect(screen.getByText('rehearsal-probe')).toHaveClass('font-mono');
    expect(container.textContent).not.toContain('—');
  });
});
