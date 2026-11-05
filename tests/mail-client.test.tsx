import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// MailClient reads the active project segment to tag new sends with their
// deal; jsdom has no App Router context, so pin the param here.
const nav = vi.hoisted(() => ({ projectId: 'zephy-2026-640' }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: nav.projectId }),
}));
// The composer sends the deal's canonical code from the deal listing.
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  const deals = [{ id: 'zephy-2026-640', code: 'ZEPHY-2026-640', codename: 'Project Zephyr' }];
  return {
    ...actual,
    useDeals: () => ({ state: { status: 'ready', deals }, deals, loading: false, error: false, reload: () => {} }),
  };
});

import { SessionProvider } from '../src/lib/session/store';
import { MailClient } from '../src/components/mail/MailClient';
import { NOT_ON_DEAL_COPY } from '../src/components/deals/DealsUnavailable';

/*
 * MailClient — the Outlook-style three-pane surface, receive side included.
 *
 * Contracts under test:
 *   1. List-first, Inbox default: folders + New message; unread inbound bold.
 *   2. Opening an inbound message fills the reading pane with Reply and marks
 *      it read (PATCH /api/v1/inbox/{id}).
 *   3. Sent list + reading pane with Reply / Forward.
 *   4. A held message, viewed by a CCO, offers Release and send / Reject; the
 *      release calls PATCH /api/v1/outbox/{id}.
 *   5. A rejected message surfaces the reviewer note and Edit and resend.
 *   6. Folder counts: inbox = unread; statuses roll up (rejected -> Blocked).
 */

const OUTBOX = [
  {
    id: 'm-sent',
    recipientBoundary: 'external' as string | null | undefined,
    dealId: null,
    dealCode: null,
    status: 'sent',
    to: ['ana.moura@target.com'],
    cc: [],
    bcc: [],
    subject: 'Process update',
    body: 'The room opens Monday.',
    bodyHtml: null,
    reasons: [],
    rewrite: null,
    provider: 'noop',
    attachments: [],
    reviewNote: null,
    createdAt: '2026-07-30T10:00:00Z',
  },
  {
    id: 'm-held',
    dealId: 'd-uuid-1',
    dealCode: 'ZEPHY-2026-640',
    status: 'held',
    to: ['leo@buyer.com'],
    cc: [],
    bcc: [],
    subject: 'Valuation range',
    body: 'Our internal model floors this at $510M',
    bodyHtml: null,
    reasons: [
      'Contains MNPI. Routed to supervisory queue, not blocked.',
      'Recipient sits outside the wall-crossed list.',
    ],
    rewrite: null,
    provider: null,
    attachments: [],
    reviewNote: null,
    createdAt: '2026-07-30T09:30:00Z',
  },
  {
    id: 'm-rejected',
    dealId: null,
    dealCode: null,
    status: 'rejected',
    to: ['leo@buyer.com'],
    cc: [],
    bcc: [],
    subject: 'Deal floor',
    body: 'The floor is firm.',
    bodyHtml: null,
    reasons: ['Contains MNPI. Routed to supervisory queue, not blocked.'],
    rewrite: null,
    provider: null,
    attachments: [],
    reviewNote: 'Remove the number before sending.',
    createdAt: '2026-07-30T09:00:00Z',
  },
];

const INBOX = [
  {
    id: 'in-1',
    from: 'ana.moura@target.com',
    to: 'projectgunners@conductia.dev',
    cc: [],
    subject: 'Re: Process update',
    body: 'Monday works. Sending the list tomorrow.',
    bodyHtml: null,
    attachments: [],
    receivedAt: '2026-07-30T11:00:00Z',
    read: false,
  },
];

// Default firm_role is null — the ordinary sender carries NO firm role in
// production (seed: md, deal-team, legal). Stubbing 'member' here once masked
// a bug where the banner required a non-null role and never showed for senders.
function stubFetch(
  firmRole: string | null = null,
  outboxRef: { messages: Array<Omit<(typeof OUTBOX)[number], 'recipientBoundary'> & { recipientBoundary?: string | null; riskBand?: string | null }> } = { messages: OUTBOX },
  opts: {
    me?: 'ok' | 'pending' | 'fail';
    inboxStatus?: number;
    outboxStatus?: number;
    isExternal?: boolean;
  } = {},
) {
  const meMode = opts.me ?? 'ok';
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (u.includes('/api/v1/outbox') && (init?.method ?? 'GET') === 'PATCH') {
        return {
          ok: true,
          json: async () => ({ message: { id: 'm-held', status: 'sent' } }),
        } as Response;
      }
      if (u.includes('/api/v1/outbox') && (init?.method ?? 'GET') === 'POST') {
        return {
          ok: true,
          json: async () => ({
            message: { id: 'm-new', status: 'held', verdict: 'hold', reasons: [] },
          }),
        } as Response;
      }
      if (u.includes('/api/v1/outbox')) {
        if (opts.outboxStatus) return { ok: false, status: opts.outboxStatus, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ messages: outboxRef.messages }) } as Response;
      }
      if (u.includes('/api/v1/inbox/')) {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (u.includes('/api/v1/inbox')) {
        if (opts.inboxStatus) return { ok: false, status: opts.inboxStatus, json: async () => ({}) } as Response;
        return { ok: true, json: async () => ({ messages: INBOX }) } as Response;
      }
      if (u.includes('/api/v1/me')) {
        if (meMode === 'pending') return new Promise<Response>(() => {});
        if (meMode === 'fail') {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            user: { firm_role: firmRole, is_external: opts.isExternal ?? false, email: 'storm@ignatious.com' },
          }),
        } as Response;
      }
      if (u.startsWith('/api/v1/deals/')) {
        return { ok: true, status: 200, json: async () => ({ deal: { lifecycleCategory: 'live' } }) } as Response;
      }
      if (u.includes('/api/v1/mail-domain-policy')) return { ok: true, json: async () => ({ verifiedDomains: [] }) } as Response;
      if (u.includes('/api/v1/screen')) {
        return {
          ok: true,
          json: async () => ({ verdict: 'compliant', reasons: [], mode: 'fast', llmChecked: false }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  return calls;
}

function renderClient() {
  return render(
    <SessionProvider>
      <MailClient />
    </SessionProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MailClient', () => {
  it('is list-first with Inbox as the default folder', async () => {
    stubFetch();
    renderClient();
    expect(screen.getByRole('button', { name: /new message/i })).toBeInTheDocument();
    for (const label of ['Inbox', 'Drafts', 'Sent']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
    await waitFor(() =>
      expect(screen.getByText('ana.moura@target.com')).toBeInTheDocument(),
    );
  });

  it('folders sit in a left column in Outlook order; Held and Blocked appear once they hold mail', async () => {
    stubFetch();
    renderClient();
    const nav = screen.getByRole('navigation', { name: 'Mail folders' });
    // The fixtures hold one held and one rejected message.
    await waitFor(() => expect(within(nav).getByRole('button', { name: /held for review/i })).toBeInTheDocument());
    const labels = within(nav)
      .getAllByRole('listitem')
      .map((li) => li.textContent?.replace(/\d+$/, ''));
    expect(labels).toEqual(['Inbox', 'Drafts', 'Sent', 'Held for review', 'Blocked']);
  });

  it('with nothing held or blocked, those folders are absent', async () => {
    stubFetch(null, { messages: [OUTBOX[0]] });
    renderClient();
    await waitFor(() => expect(screen.getByText('ana.moura@target.com')).toBeInTheDocument());
    const nav = screen.getByRole('navigation', { name: 'Mail folders' });
    expect(within(nav).getAllByRole('listitem').map((li) => li.textContent?.replace(/\d+$/, ''))).toEqual([
      'Inbox',
      'Drafts',
      'Sent',
    ]);
  });

  it('on a phone shows one pane at a time: Back to messages returns to the list with focus on the row', async () => {
    // Below md: jsdom has no layout, so the phone query is stubbed.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query }));
    stubFetch();
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^sent/i }));
    const row = (await screen.findByText('Process update')).closest('button')!;
    const list = screen.getByRole('region', { name: 'Message list' });
    const pane = screen.getByRole('region', { name: 'Reading pane' });
    expect(list.className.split(' ')).toContain('flex');
    expect(pane.className.split(' ')).toContain('hidden');

    fireEvent.click(row);
    const back = screen.getByRole('button', { name: 'Back to messages' });
    expect(list.className.split(' ')).toContain('hidden');
    expect(pane.className.split(' ')).not.toContain('hidden');
    // The list that held focus is hidden, so focus moves to Back.
    await waitFor(() => expect(document.activeElement).toBe(back));

    fireEvent.click(back);
    expect(screen.queryByRole('button', { name: 'Back to messages' })).toBeNull();
    expect(list.className.split(' ')).not.toContain('hidden');
    expect(pane.className.split(' ')).toContain('hidden');
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it('on desktop opening a message leaves focus where it was', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    stubFetch();
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^sent/i }));
    const row = (await screen.findByText('Process update')).closest('button')!;
    row.focus();
    fireEvent.click(row);
    await screen.findByRole('heading', { name: 'Process update' });
    expect(document.activeElement).toBe(row);
  });

  it('shows the screening line at every width, never behind a desktop-only class', async () => {
    stubFetch();
    renderClient();
    const line = await screen.findByText('Every message is screened before it leaves.');
    for (let el: HTMLElement | null = line; el; el = el.parentElement) {
      expect(el.classList.contains('hidden')).toBe(false);
    }
  });

  it('has no Mail settings control; it points to Settings › Mail', async () => {
    const calls = stubFetch();
    renderClient();
    await waitFor(() => expect(screen.getByText('ana.moura@target.com')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /mail settings/i })).toBeNull();
    expect(screen.queryByText(/mail settings/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Settings › Mail' })).toHaveAttribute('href', '/settings?section=mail');
    // The mailbox status is Settings' business now.
    expect(calls.some((c) => c.url === '/api/v1/mailbox')).toBe(false);
  });

  it('opens an inbound message with Reply and marks it read', async () => {
    const calls = stubFetch();
    renderClient();
    await waitFor(() =>
      expect(screen.getByText('ana.moura@target.com')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText('ana.moura@target.com'));

    expect(screen.getByRole('heading', { name: 'Re: Process update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reply$/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url.includes('/api/v1/inbox/in-1') && c.method === 'PATCH'),
      ).toBe(true),
    );
  });

  it('shows the Sent list and reading pane with Reply and Forward', async () => {
    stubFetch();
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^sent/i }));
    await waitFor(() => expect(screen.getByText('Process update')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Process update'));

    expect(screen.getByRole('heading', { name: 'Process update' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reply$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /forward/i })).toBeInTheDocument();
  });

  it('lets a CCO release a held message', async () => {
    const calls = stubFetch('cco');
    renderClient();
    fireEvent.click(await screen.findByRole('button', { name: /held for review/i }));
    await waitFor(() => expect(screen.getByText('Valuation range')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Valuation range'));

    expect(screen.getByLabelText(/review note/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /release and send/i }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/api/v1/outbox/m-held') &&
            c.method === 'PATCH' &&
            (c.body as { action?: string })?.action === 'release',
        ),
      ).toBe(true),
    );
  });

  it('the held card lists every hold reason and says the decision is recorded', async () => {
    stubFetch('cco');
    renderClient();
    fireEvent.click(await screen.findByRole('button', { name: /held for review/i }));
    await waitFor(() => expect(screen.getByText('Valuation range')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Valuation range'));

    expect(screen.getByText(/contains mnpi/i)).toBeInTheDocument();
    expect(screen.getByText(/outside the wall-crossed list/i)).toBeInTheDocument();
    // The receipt line names the time only; the deal code stays off it.
    expect(within(screen.getByRole('region', { name: 'Reading pane' })).getByText(/^Held (?!for)/)).not.toHaveTextContent('ZEPHY-2026-640');
    expect(screen.getByText('Releasing or rejecting it is recorded in the audit trail.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Reading pane' }).textContent).not.toMatch(/register|#192/);
  });

  it('a sent-and-queued message reads in plain English, with no issue number', async () => {
    stubFetch(null, {
      messages: [{ ...OUTBOX[0], id: 'm-queued', subject: 'Queued one', riskBand: 'queued', reasons: ['Reads as a price commitment.'] }],
    });
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^sent/i }));
    fireEvent.click(await screen.findByText('Queued one'));
    const pane = screen.getByRole('region', { name: 'Reading pane' });
    expect(pane.textContent).toContain('Delivered. Your compliance team reviews it after sending.');
    expect(pane.textContent).toContain('That decision is in the audit trail.');
    expect(pane.textContent).not.toMatch(/#192|register|banded|dispositions/);
  });

  it('a banker sees the held notice without review controls', async () => {
    stubFetch();
    renderClient();
    fireEvent.click(await screen.findByRole('button', { name: /held for review/i }));
    await waitFor(() => expect(screen.getByText('Valuation range')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Valuation range'));

    expect(screen.getByText(/a supervisor will review/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /release and send/i })).not.toBeInTheDocument();
  });

  it('a rejected message shows the reviewer note and Edit and resend', async () => {
    stubFetch();
    renderClient();
    fireEvent.click(await screen.findByRole('button', { name: /blocked/i }));
    await waitFor(() => expect(screen.getByText('Deal floor')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Deal floor'));

    expect(screen.getByText(/returned by supervisory review/i)).toBeInTheDocument();
    expect(screen.getByText('Remove the number before sending.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit and resend/i })).toBeInTheDocument();
  });

  it('counts: inbox unread, statuses rolled up (rejected in Blocked)', async () => {
    stubFetch();
    renderClient();
    await waitFor(() =>
      expect(screen.getByText('ana.moura@target.com')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /inbox/i }).textContent).toContain('1');
    expect(screen.getByRole('button', { name: /^sent/i }).textContent).toContain('1');
    // rejected rolls up into Blocked (no plain-blocked fixture -> count 1).
    expect((await screen.findByRole('button', { name: /blocked/i })).textContent).toContain('1');
    expect(screen.getByRole('button', { name: /held for review/i }).textContent).toContain('1');
  });

  it('New message opens the composer', async () => {
    stubFetch();
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /new message/i }));
    expect(await screen.findByLabelText(/compose email/i)).toBeInTheDocument();
  });

  it('New message moves focus to the To field', async () => {
    stubFetch();
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /new message/i }));
    const section = await screen.findByLabelText(/compose email/i);
    await waitFor(() => expect(section.querySelector('[aria-label="To"]')).toHaveFocus());
  });

  it('on a phone, New message also puts focus on To, never on Back to messages', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query }));
    stubFetch();
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /new message/i }));
    const section = await screen.findByLabelText(/compose email/i);
    expect(screen.getByRole('button', { name: 'Back to messages' })).toBeInTheDocument();
    await waitFor(() => expect(section.querySelector('[aria-label="To"]')).toHaveFocus());
  });

  it.each([
    ['desktop', false],
    ['a phone', true],
  ])('on %s, Discard returns focus to New message', async (_width, phone) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query.includes('max-width'), media: query }));
    stubFetch();
    renderClient();
    const newMessage = screen.getByRole('button', { name: /new message/i });
    fireEvent.click(newMessage);
    await screen.findByLabelText(/compose email/i);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByLabelText(/compose email/i)).toBeNull());
    await waitFor(() => expect(newMessage).toHaveFocus());
  });

  it('a failed inbox read is a load error with Try again, not an empty inbox', async () => {
    const calls = stubFetch('cco', undefined, { inboxStatus: 500 });
    renderClient();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/inbox could not be loaded/i);
    expect(screen.queryByText(/no mail yet/i)).toBeNull();
    const before = calls.filter((c) => c.url.startsWith('/api/v1/inbox')).length;
    fireEvent.click(within(alert).getByRole('button', { name: /try again/i }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.startsWith('/api/v1/inbox')).length).toBeGreaterThan(before),
    );
  });

  it('a failed outbox read keeps Held reachable and the inbox states the error', async () => {
    stubFetch(null, undefined, { outboxStatus: 500 });
    renderClient();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByText(/no mail yet/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /held for review/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
  });

  it('no pane hint describes the empty reading pane', async () => {
    stubFetch();
    renderClient();
    await screen.findByText('ana.moura@target.com');
    expect(screen.queryByText(/select a message to read it/i)).toBeNull();
  });

  it('an inbox 403 keeps the quiet empty state', async () => {
    stubFetch('cco', undefined, { inboxStatus: 403 });
    renderClient();
    expect(await screen.findByText(/no mail yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/inbox could not be loaded/i)).toBeNull();
  });

  it('scopes the outbox and inbox fetches to the active project', async () => {
    const calls = stubFetch();
    renderClient();
    await waitFor(() =>
      expect(
        calls.some((c) => c.url === '/api/v1/outbox?dealId=zephy-2026-640' && c.method === 'GET'),
      ).toBe(true),
    );
    expect(calls.some((c) => c.url === '/api/v1/inbox?dealId=zephy-2026-640')).toBe(true);
  });

  it('an overseer additionally loads the tenant-wide held queue (no deal filter)', async () => {
    const calls = stubFetch('cco');
    renderClient();
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/outbox?status=held')).toBe(true),
    );
    // The supervisory fetch deliberately carries NO dealId.
    const heldCall = calls.find((c) => c.url.includes('status=held'));
    expect(heldCall?.url.includes('dealId')).toBe(false);
    // #192 slice 3: the POST-send queue rides along — sent messages whose
    // screen banded them 'queued' are the review surface now that nothing
    // holds before sending.
    expect(
      calls.some((c) => c.url === '/api/v1/outbox?status=sent&band=queued'),
    ).toBe(true);
  });

  it('the supervisory queue names the deal by its codename, never its code', async () => {
    stubFetch('cco');
    renderClient();
    fireEvent.click(await screen.findByRole('button', { name: /held for review/i }));
    await waitFor(() => expect(screen.getByText('Valuation range')).toBeInTheDocument());
    const list = screen.getByRole('region', { name: 'Message list' });
    expect(within(list).getByText('Project Zephyr')).toBeInTheDocument();
    expect(list.textContent).not.toMatch(/[A-Z]+-\d{4}-\d{3}/);
  });

  it('the held meta line carries no deal code', async () => {
    stubFetch('cco');
    renderClient();
    fireEvent.click(await screen.findByRole('button', { name: /held for review/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Valuation range/ }));
    const pane = screen.getByRole('region', { name: 'Reading pane' });
    await waitFor(() => expect(within(pane).getByText(/^Held (?!for)/)).toBeInTheDocument());
    expect(pane.textContent).not.toMatch(/[A-Z]+-\d{4}-\d{3}/);
  });

  it('has exactly one h1, "Mail", for assistive tech', async () => {
    stubFetch();
    renderClient();
    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Mail');
  });

  it('shows the Settings › Mail link at every width, under the folders', async () => {
    stubFetch();
    renderClient();
    const link = await screen.findByRole('link', { name: 'Settings › Mail' });
    for (let el: HTMLElement | null = link; el; el = el.parentElement) {
      expect(el.classList.contains('hidden')).toBe(false);
    }
  });

  it('an outside party gets no Settings › Mail pointer (Settings hides Mail for them)', async () => {
    stubFetch(null, { messages: OUTBOX }, { isExternal: true });
    renderClient();
    await screen.findByText('Every message is screened before it leaves.');
    await waitFor(() => expect(screen.getByText('ana.moura@target.com')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Settings › Mail' })).toBeNull();
    expect(screen.queryByText(/mailbox connection and signature/i)).toBeNull();
  });

  it('a bank-side viewer gets the Settings › Mail pointer once /api/v1/me answers', async () => {
    stubFetch(null, { messages: OUTBOX }, { isExternal: false });
    renderClient();
    expect(await screen.findByRole('link', { name: 'Settings › Mail' })).toHaveAttribute(
      'href',
      '/settings?section=mail',
    );
  });

  it('resurfaces held/returned messages in a banner for the sender (never silent)', async () => {
    stubFetch();
    renderClient();
    // Fixtures: 1 held + 1 rejected -> both called out.
    await waitFor(() =>
      expect(screen.getByText(/1 message returned to you · 1 held for review/i)).toBeInTheDocument(),
    );
    // Open jumps straight to the message needing the sender's action first
    // (the returned one) in its folder.
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    expect(screen.getByRole('heading', { name: 'Deal floor' })).toBeInTheDocument();
    expect(screen.getByText(/returned by supervisory review/i)).toBeInTheDocument();
    // Dismiss hides the banner.
    fireEvent.click(screen.getByRole('button', { name: /dismiss review notice/i }));
    expect(screen.queryByRole('button', { name: /^open$/i })).not.toBeInTheDocument();
  });

  it('a dismissed banner pops back up when a NEW message is held (never silent)', async () => {
    const outboxRef = { messages: OUTBOX };
    stubFetch(null, outboxRef);
    renderClient();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^open$/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss review notice/i }));
    expect(screen.queryByRole('button', { name: /^open$/i })).not.toBeInTheDocument();

    // A new send is held while the client is open; the post-send refetch
    // delivers it and the banner must resurface despite the dismissal.
    outboxRef.messages = [
      ...OUTBOX,
      { ...OUTBOX[1], id: 'm-held-2', subject: 'Second held message' },
    ];
    fireEvent.click(screen.getByRole('button', { name: /new message/i }));
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: 'leo@buyer.com' },
    });
    fireEvent.change(screen.getByLabelText(/^subject$/i), {
      target: { value: 'Second try' },
    });
    fireEvent.input(screen.getByLabelText(/^message$/i), {
      target: { innerHTML: 'Numbers redacted.' },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() =>
      expect(screen.getByText(/2 held for review/i)).toBeInTheDocument(),
    );
  });

  it('no banner before /api/v1/me answers (an overseer outbox must never be misclaimed)', async () => {
    stubFetch(null, { messages: OUTBOX }, { me: 'pending' });
    renderClient();
    // With /me unanswered the guard holds the banner down regardless of the
    // held/rejected rows the outbox may carry.
    await Promise.resolve();
    expect(screen.queryByText(/returned to you/i)).toBeNull();
  });

  it('a failed /api/v1/me suppresses the banner but NOT silently (load error surfaces)', async () => {
    stubFetch(null, { messages: OUTBOX }, { me: 'fail' });
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /^sent/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText(/returned to you/i)).toBeNull();
  });

  it('an EXTERNAL user with an overseer firm_role is an ordinary sender (mirrors the server wall)', async () => {
    const calls = stubFetch('cco', { messages: OUTBOX }, { isExternal: true });
    renderClient();
    // Their own held/returned rows banner normally…
    await waitFor(() =>
      expect(screen.getByText(/1 message returned to you · 1 held for review/i)).toBeInTheDocument(),
    );
    // …and the tenant-wide supervisory queue is never fetched.
    expect(calls.some((c) => c.url.includes('status=held'))).toBe(false);
  });

  it('an overseer works the queue instead — no resurface banner', async () => {
    stubFetch('cco');
    renderClient();
    await waitFor(() =>
      expect(screen.getByText('ana.moura@target.com')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /^open$/i })).not.toBeInTheDocument();
  });

  it('drafts are kept per project (another project’s drafts stay invisible)', async () => {
    const draft = (id: string, subject: string) => ({
      id,
      to: 'founder@target.com',
      cc: '',
      bcc: '',
      subject,
      bodyHtml: '<p>hi</p>',
      updatedAt: '2026-08-07T10:00:00Z',
    });
    localStorage.setItem(
      'conductia.mail.drafts:zephy-2026-640',
      JSON.stringify([draft('d1', 'This project draft')]),
    );
    localStorage.setItem(
      'conductia.mail.drafts:other-project',
      JSON.stringify([draft('d2', 'Other project draft')]),
    );
    stubFetch();
    renderClient();
    fireEvent.click(screen.getByRole('button', { name: /drafts/i }));
    await waitFor(() => expect(screen.getByText('This project draft')).toBeInTheDocument());
    expect(screen.queryByText('Other project draft')).not.toBeInTheDocument();
  });
});

it.each([
  ['external', 'External recipient'],
  ['internal', 'Internal recipients'],
  ['unverified', 'Could not tell if recipients are outside the firm'],
  [undefined, 'Not recorded whether recipients are outside the firm'],
  [null, 'Not recorded whether recipients are outside the firm'],
])('displays the persisted boundary %s without reclassification', async (boundary, label) => {
  stubFetch(null, { messages: [{...OUTBOX[0], recipientBoundary: boundary}] });
  renderClient();
  fireEvent.click(screen.getByRole('button', {name:/^sent/i}));
  fireEvent.click(await screen.findByRole('button', {name:/Process update/}));
  expect(screen.getByText(label as string)).toBeInTheDocument();
  if (boundary !== 'internal') expect(screen.queryByText('Internal recipients')).not.toBeInTheDocument();
});

// S6R4-R1: a deal the viewer is not on. The overseer's Held folder is the
// tenant-wide supervisory queue, so a CCO who follows a hold notification
// into a deal they are not seated on still reviews it; nothing deal-scoped
// shows, and nothing can be sent from here.
describe('MailClient on a deal the viewer is not on', () => {
  beforeEach(() => {
    nav.projectId = 'SUMMIT-2026-003';
  });
  afterEach(() => {
    nav.projectId = 'zephy-2026-640';
    window.history.replaceState(null, '', '/');
  });

  it('an overseer following ?folder=held keeps the Held queue and its review actions, with no composer', async () => {
    window.history.replaceState(null, '', '/projects/SUMMIT-2026-003/mail?folder=held');
    const calls = stubFetch('cco');
    renderClient();
    expect(await screen.findByText(NOT_ON_DEAL_COPY)).toBeInTheDocument();
    // Held-only keeps the page's own h1 and adds none (S6R5-06).
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const folders = screen.getByRole('navigation', { name: 'Mail folders' });
    const held = within(folders).getByRole('button', { name: /held for review/i });
    expect(held).toHaveAttribute('aria-current', 'true');
    for (const name of [/^inbox/i, /^drafts/i, /^sent/i, /^blocked/i]) {
      expect(within(folders).queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /new message/i })).toBeNull();
    // No composer here, so no pointer to the mailbox settings (S6R5-04).
    expect(screen.getByText('Every message is screened before it leaves.')).toBeInTheDocument();
    expect(screen.queryByText(/Your mailbox connection and signature are in/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings › Mail' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /Valuation range/ }));
    expect(screen.getByLabelText(/review note/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /release and send/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit and resend/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /release and send/i }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes('/api/v1/outbox/m-held') &&
            c.method === 'PATCH' &&
            (c.body as { action?: string })?.action === 'release',
        ),
      ).toBe(true),
    );

    // A queued sent row in the same folder offers no Reply or Forward.
    fireEvent.click(screen.getByRole('button', { name: /Process update/ }));
    // The pane opened on that row, so the absence checks below are not vacuous.
    const pane = screen.getByRole('region', { name: 'Reading pane' });
    expect(await within(pane).findByRole('heading', { name: 'Process update' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reply$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /forward/i })).toBeNull();
    expect(screen.queryByLabelText(/compose email/i)).toBeNull();
  });

  it('the same overseer on a deal they are on keeps the Settings › Mail pointer', async () => {
    nav.projectId = 'zephy-2026-640';
    stubFetch('cco');
    renderClient();
    expect(await screen.findByRole('link', { name: 'Settings › Mail' })).toHaveAttribute('href', '/settings?section=mail');
  });

  it('an overseer lands on Held even without ?folder=held, since it is the only folder', async () => {
    stubFetch('admin');
    renderClient();
    expect(await screen.findByText(NOT_ON_DEAL_COPY)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Valuation range/ })).toBeInTheDocument();
    expect(screen.queryByText('No mail yet.')).toBeNull();
  });

  it('a non-overseer sees only the not-on-deal state', async () => {
    stubFetch(null);
    renderClient();
    expect(await screen.findByText(NOT_ON_DEAL_COPY)).toBeInTheDocument();
    // The page's one h1 (S6R5-06).
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Mail' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Mail folders' })).toBeNull();
    expect(screen.queryByRole('button', { name: /new message/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /held for review/i })).toBeNull();
    expect(screen.queryByText('Valuation range')).toBeNull();
  });

  it('while /me is unresolved it shows the loading state, never the not-on-deal state', async () => {
    stubFetch('cco', undefined, { me: 'pending' });
    renderClient();
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText(NOT_ON_DEAL_COPY)).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Mail folders' })).toBeNull();
  });
});

// S6R5-05: a ?folder= link keeps its param, like a ?step= link on the rail,
// with no new history entry; it is read once, so a lagging param never
// re-opens the folder after the MD moves on.
describe('MailClient ?folder= links', () => {
  let push: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    push = vi.spyOn(window.history, 'pushState');
  });
  afterEach(() => {
    push.mockRestore();
    window.history.replaceState(null, '', '/');
  });

  const folderButton = (name: RegExp) =>
    within(screen.getByRole('navigation', { name: 'Mail folders' })).getByRole('button', { name });

  it('?folder=held opens Held and keeps the param in the address bar', async () => {
    window.history.replaceState(null, '', '/projects/zephy-2026-640/mail?folder=held');
    stubFetch('cco');
    renderClient();
    await waitFor(() => expect(folderButton(/held for review/i)).toHaveAttribute('aria-current', 'true'));
    expect(await screen.findByRole('button', { name: /Valuation range/ })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.location.search).toBe('?folder=held');
    expect(push).not.toHaveBeenCalled();
  });

  it('opening another folder drops the param in place, and a lagging ?folder=held never re-opens Held', async () => {
    window.history.replaceState(null, '', '/projects/zephy-2026-640/mail?folder=held');
    stubFetch('cco');
    const view = renderClient();
    await waitFor(() => expect(folderButton(/held for review/i)).toHaveAttribute('aria-current', 'true'));
    fireEvent.click(folderButton(/^inbox/i));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(push).not.toHaveBeenCalled();

    // The router still reports the old param for a render (Next updates it
    // in a transition): the stale URL comes back and the page re-renders.
    window.history.replaceState(null, '', '/projects/zephy-2026-640/mail?folder=held');
    view.rerender(
      <SessionProvider>
        <MailClient />
      </SessionProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(folderButton(/^inbox/i)).toHaveAttribute('aria-current', 'true');
    expect(folderButton(/held for review/i)).not.toHaveAttribute('aria-current');
  });

  it('an unknown ?folder= is dropped and the inbox opens', async () => {
    window.history.replaceState(null, '', '/projects/zephy-2026-640/mail?folder=nope');
    stubFetch(null);
    renderClient();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(folderButton(/^inbox/i)).toHaveAttribute('aria-current', 'true');
  });
});
