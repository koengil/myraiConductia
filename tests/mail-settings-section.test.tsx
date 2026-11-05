import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MailSettingsSection } from '../src/components/mail/MailSettingsSection';
import { PREVIEW_COPY } from '../src/components/overlay';

/*
 * Settings › Mail: only what is Conductia's own.
 * Send from your mailbox, deal discovery, the signature import Preview, and,
 * for the CCO or an admin, the firm's compliance settings.
 */

type StubOptions = {
  firmRole?: string | null;
  isExternal?: boolean;
  /** GET /api/v1/mailbox's answer (#490). */
  mailbox?: Record<string, unknown>;
  /** The Connect for sending preflight's answer; throw for a network failure. */
  connect?: () => Response;
};

function stubFetch(opts: StubOptions = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      if (u === '/api/v1/me') {
        return {
          ok: true,
          json: async () => ({
            user: { firm_role: opts.firmRole ?? null, is_external: opts.isExternal ?? false, email: 'storm@ignatious.com' },
          }),
        } as Response;
      }
      if (u.startsWith('/api/v1/mailbox/google/connect')) {
        if (!opts.connect) throw new Error('unexpected connect preflight');
        return opts.connect();
      }
      if (u === '/api/v1/mailbox' && method === 'DELETE') {
        return { ok: true, status: 204, json: async () => ({}) } as Response;
      }
      if (u === '/api/v1/mailbox') {
        const body = opts.mailbox ?? { configured: false, connected: false };
        return { ok: true, json: async () => body } as Response;
      }
      if (u === '/api/v1/discovery/mailbox-consent') {
        return { ok: true, json: async () => ({ eligible: true, consented: false, address: 'storm@ignatious.com' }) } as Response;
      }
      if (u.startsWith('/api/v1/compliance-settings')) {
        return {
          ok: true,
          json: async () => ({
            settings: { sampledFrom: 40, queuedFrom: 70, uncheckedFloor: 'sampled', sendFriction: 'one_click' },
            isDefault: true,
            canEdit: opts.firmRole === 'cco',
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${u}`);
    }),
  );
  return calls;
}

function renderSection() {
  return render(<MailSettingsSection />);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/settings?section=mail');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('MailSettingsSection', () => {
  it('holds the mailbox cards and the signature Preview, and no compliance settings for a banker', async () => {
    const calls = stubFetch();
    renderSection();
    expect(await screen.findByRole('region', { name: 'Send from your mailbox' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Signature/ })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/me')).toBe(true));
    expect(screen.queryByRole('form', { name: 'Firm compliance settings' })).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/v1/compliance-settings'))).toBe(false);
  });

  it.each(['cco', 'admin'])('a %s also gets the firm compliance settings', async (firmRole) => {
    stubFetch({ firmRole });
    renderSection();
    expect(await screen.findByRole('form', { name: 'Firm compliance settings' })).toBeInTheDocument();
  });

  it('an external user is never shown the compliance settings, whatever firm_role says', async () => {
    const calls = stubFetch({ firmRole: 'cco', isExternal: true });
    renderSection();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/me')).toBe(true));
    await screen.findByRole('region', { name: 'Send from your mailbox' });
    expect(calls.some((c) => c.url.startsWith('/api/v1/compliance-settings'))).toBe(false);
  });

  it('signature import is a Preview: the chip, two imports, no editor, nothing read or written', async () => {
    const calls = stubFetch();
    renderSection();
    const signature = await screen.findByRole('region', { name: /Signature/ });
    expect(signature.querySelector('[data-preview="chip"]')).not.toBeNull();
    expect(signature.textContent).toContain(PREVIEW_COPY.description);
    expect(signature.textContent).toMatch(/needs your permission for Conductia to read your mailbox settings/);
    expect(signature.querySelector('textarea, input, [contenteditable]')).toBeNull();
    const before = calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Import from Gmail' }));
    expect(signature.textContent).toMatch(/Nothing was imported\. Gmail import needs that permission/);
    fireEvent.click(screen.getByRole('button', { name: 'Import from Outlook' }));
    expect(signature.textContent).toMatch(/Outlook import needs that permission/);
    expect(calls.slice(before)).toEqual([]);
    expect(signature.textContent).not.toMatch(/[—–?]/);
  });

  it('says what stays in the mail client, with no dashes', async () => {
    stubFetch();
    const { container } = renderSection();
    await screen.findByRole('region', { name: 'Send from your mailbox' });
    expect(container.textContent).toMatch(/Folders, rules, out of office and the rest stay in your own mail client/);
    expect(container.textContent).not.toMatch(/[—]|reader registration|#\d+/);
  });

  it('a connect round trip comes back to Settings › Mail', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    stubFetch({
      mailbox: { configured: true, connected: false, providers: { microsoft: false, google: true } },
      connect: () => ({ ok: false, status: 0, type: 'opaqueredirect' }) as Response,
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect for sending' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        `/api/v1/mailbox/google/connect?next=${encodeURIComponent('/settings?section=mail')}`,
      ),
    );
  });

  it('back from a connect, the notice params are dropped and section=mail is kept', async () => {
    window.history.replaceState(null, '', '/settings?section=mail&mailbox=error&reason=failed');
    stubFetch({ mailbox: { configured: true, connected: false, providers: { microsoft: false, google: true } } });
    renderSection();
    await screen.findByRole('alert');
    expect(window.location.search).toBe('?section=mail');
  });
});

/*
 * Send from your mailbox, Gmail (#490 S3b). The card's states come from GET
 * /api/v1/mailbox: providers (which sending clients exist), and for a Google
 * row its status. Contracts:
 *   - nothing configured, Gmail to connect, both providers, connected,
 *     approval ended, and Gmail switched off with a row still held;
 *   - Connect for sending asks the connect route first without following it:
 *     a redirect navigates, a 409 says no_firm_domain, anything else failed;
 *   - back from a connect, ?mailbox=error&reason= shows the reason's copy
 *     (never the raw param) and is dropped from the URL, keeping ?section=mail;
 *   - the copy carries no dashes and asks no questions.
 */
describe('Settings › Mail: send from your mailbox, Gmail (#490)', () => {
  const GOOGLE_ONLY = { microsoft: false, google: true };
  const googleRow = (status: 'connected' | 'revoked', providers = GOOGLE_ONLY) => ({
    configured: providers.microsoft || providers.google,
    connected: status === 'connected',
    email: 'storm@ignatious.com',
    provider: 'google',
    status,
    connectedAt: '2026-10-17T10:00:00Z',
    providers,
  });

  const card = () => screen.getByRole('region', { name: 'Send from your mailbox' });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('nothing configured: says so and offers no connect', async () => {
    stubFetch({
      mailbox: { configured: false, connected: false, providers: { microsoft: false, google: false } },
    });
    renderSection();
    expect(
      await screen.findByText(/Sending from your own mailbox is not set up in Conductia yet/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect for sending' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect Microsoft 365' })).toBeNull();
  });

  it('Gmail configured, not connected: Connect for sending, and no Microsoft button', async () => {
    stubFetch({ mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY } });
    renderSection();
    expect(await screen.findByRole('button', { name: 'Connect for sending' })).toBeInTheDocument();
    expect(card().textContent).toMatch(/appears in your Gmail Sent folder/);
    expect(card().textContent).toMatch(/Send email on your behalf/);
    expect(screen.queryByRole('button', { name: 'Connect Microsoft 365' })).toBeNull();
  });

  it('both providers configured: both connect buttons (T6)', async () => {
    stubFetch({
      mailbox: { configured: true, connected: false, providers: { microsoft: true, google: true } },
    });
    renderSection();
    expect(await screen.findByRole('button', { name: 'Connect for sending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Microsoft 365' })).toBeInTheDocument();
  });

  it('Connect for sending asks the connect route without following it, then navigates there', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const calls = stubFetch({
      mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY },
      connect: () => ({ ok: false, status: 0, type: 'opaqueredirect' }) as Response,
    });
    const fetchMock = vi.mocked(fetch);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect for sending' }));
    const href = `/api/v1/mailbox/google/connect?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    await waitFor(() => expect(assign).toHaveBeenCalledWith(href));
    expect(calls.some((c) => c.url === href)).toBe(true);
    expect(fetchMock.mock.calls.find(([u]) => String(u) === href)?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it.each([
    ['a 409', () => ({ ok: false, status: 409, type: 'basic' }) as Response, /not set up for sending yet\. Ask the Conductia team\./],
    ['a 403', () => ({ ok: false, status: 403, type: 'basic' }) as Response, /for the bank's own team\. Use the deal's threads instead\./],
    ['a 503', () => ({ ok: false, status: 503, type: 'basic' }) as Response, /The connection did not complete\. Try again\./],
    ['a network failure', () => { throw new TypeError('offline'); }, /The connection did not complete\. Try again\./],
  ])('a preflight answering %s stays on the card and says why', async (_label, connect, copy) => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    stubFetch({
      mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY },
      connect,
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect for sending' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    expect(assign).not.toHaveBeenCalled();
  });

  it('connected: the address, Disconnect and where mail goes after it', async () => {
    stubFetch({ mailbox: googleRow('connected') });
    renderSection();
    expect(await screen.findByText(/Connected for sending as/)).toBeInTheDocument();
    expect(card().textContent).toContain('storm@ignatious.com');
    expect(card().textContent).toMatch(/appears in your Sent folder/);
    expect(card().textContent).toMatch(
      /Disconnect deletes Conductia's stored approval\. Mail you send here then goes out from the platform address\./,
    );
    expect(card().textContent).toMatch(/Google's linked apps page/);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect for sending' })).toBeNull();
    expect(screen.queryByText('Approval ended')).toBeNull();
  });

  it('approval ended: the badge, the copy, Connect for sending and Disconnect', async () => {
    stubFetch({ mailbox: googleRow('revoked') });
    renderSection();
    expect(await screen.findByText('Approval ended')).toBeInTheDocument();
    expect(card().textContent).toMatch(
      /Google ended Conductia's approval to send as storm@ignatious\.com\. Mail does not send until you connect again\./,
    );
    expect(screen.getByRole('button', { name: 'Connect for sending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(card().textContent).toMatch(/Disconnect deletes Conductia's stored approval/);
  });

  it('Gmail switched off with a connection held: says so, offers Disconnect only, no connected dot', async () => {
    stubFetch({
      mailbox: googleRow('connected', { microsoft: false, google: false }),
    });
    renderSection();
    expect(await screen.findByText(/Sending from Gmail is switched off in Conductia for now/)).toBeInTheDocument();
    expect(card().textContent).toMatch(
      /Mail does not send from storm@ignatious\.com until it is back\. Disconnect to send from the platform address\./,
    );
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect for sending' })).toBeNull();
    expect(screen.queryByText(/Connected for sending as/)).toBeNull();
  });

  it('a revoked row with Gmail switched off reads as switched off, with no connect', async () => {
    stubFetch({ mailbox: googleRow('revoked', { microsoft: false, google: false }) });
    renderSection();
    expect(await screen.findByText(/Sending from Gmail is switched off/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect for sending' })).toBeNull();
  });

  it('Disconnect deletes the connection and reloads the status', async () => {
    const calls = stubFetch({ mailbox: googleRow('revoked') });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/v1/mailbox' && c.method === 'DELETE')).toBe(true),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/v1/mailbox' && c.method === 'GET')).toHaveLength(2),
    );
  });

  it.each([
    ['wrong_account', 'Google connected a different account. Connect with storm@ignatious.com.'],
    ['not_workspace', "Connect with your firm's Google Workspace account, storm@ignatious.com."],
    ['scope_missing', 'Google did not grant Send email on your behalf. Connect again and allow it.'],
    ['scope_unexpected', 'Google granted more than Conductia asked for, so the connection was not kept. Tell your admin.'],
    ['no_firm_domain', "Your firm's Google Workspace is not set up for sending yet. Ask the Conductia team."],
    ['not_eligible', "Sending from Gmail is for the bank's own team. Use the deal's threads instead."],
    ['cancelled', 'The connection did not complete. Try again.'],
    ['failed', 'The connection did not complete. Try again.'],
    ['<script>', 'The connection did not complete. Try again.'],
  ])('back with ?mailbox=error&reason=%s: the card shows its copy', async (reason, copy) => {
    window.history.replaceState(null, '', `/?mailbox=error&reason=${encodeURIComponent(reason)}`);
    stubFetch({ mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY } });
    renderSection();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(copy));
    expect(card().textContent).not.toContain('<script>');
    // Dropped from the URL, so a reload does not repeat it.
    expect(window.location.search).toBe('');
  });

  it.each(['wrong_account', 'not_workspace', 'scope_missing', 'scope_unexpected', 'failed', 'not_recorded'])(
    'after Google recorded an approval (%s, granted=1), the notice says Conductia kept nothing and links to remove it',
    async (reason) => {
      window.history.replaceState(null, '', `/?mailbox=error&reason=${reason}&granted=1`);
      stubFetch({ mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY } });
      renderSection();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        'Conductia kept nothing from that approval. To remove it from the Google account, open myaccount.google.com/permissions.',
      );
      expect(screen.getByRole('link', { name: 'myaccount.google.com/permissions' })).toHaveAttribute(
        'href',
        'https://myaccount.google.com/permissions',
      );
      expect(window.location.search).toBe('');
    },
  );

  it.each(['cancelled', 'failed', 'no_firm_domain', 'wrong_account'])(
    '%s without granted=1: no approval was recorded, so no removal link',
    async (reason) => {
      window.history.replaceState(null, '', `/?mailbox=error&reason=${reason}`);
      stubFetch({ mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY } });
      renderSection();
      await screen.findByRole('alert');
      expect(screen.queryByRole('link', { name: 'myaccount.google.com/permissions' })).toBeNull();
    },
  );

  it('not_recorded says the attempt could not be recorded (#490: an unaudited refusal fails closed)', async () => {
    window.history.replaceState(null, '', '/?mailbox=error&reason=not_recorded');
    stubFetch({ mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY } });
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The connection did not complete, and Conductia could not record the attempt. Try again, and tell the Conductia team if it happens again.',
    );
  });

  it('back with ?mailbox=connected: the connected card, no notice', async () => {
    window.history.replaceState(null, '', '/?mailbox=connected');
    stubFetch({ mailbox: googleRow('connected') });
    renderSection();
    expect(await screen.findByText(/Connected for sending as/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.search).toBe('');
  });

  it.each([
    ['nothing configured', { configured: false, connected: false, providers: { microsoft: false, google: false } }, /not set up/],
    ['Gmail to connect', { configured: true, connected: false, providers: { microsoft: true, google: true } }, /Connect your Gmail/],
    ['connected', googleRow('connected'), /Connected for sending as/],
    ['approval ended', googleRow('revoked'), /^Approval ended$/],
    ['switched off', googleRow('connected', { microsoft: false, google: false }), /switched off/],
  ])('the %s copy has no dashes and asks no questions', async (_label, mailbox, shown) => {
    stubFetch({ mailbox });
    renderSection();
    await screen.findByText(shown);
    expect(card().textContent).not.toMatch(/[\u2014\u2013?]|\s-\s/);
  });

  it('no refusal copy has dashes or asks questions', async () => {
    for (const reason of ['wrong_account', 'not_workspace', 'scope_missing', 'scope_unexpected', 'no_firm_domain', 'not_eligible', 'failed']) {
      window.history.replaceState(null, '', `/?mailbox=error&reason=${reason}`);
      stubFetch({ mailbox: { configured: true, connected: false, providers: GOOGLE_ONLY } });
      renderSection();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent, reason).not.toMatch(/[\u2014\u2013?]|\s-\s/);
      cleanup();
    }
  });
});
