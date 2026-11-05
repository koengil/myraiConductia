import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { CONNECT_GMAIL_HREF, ConnectGmailBanner } from '@/components/discovery/ConnectGmailBanner';

const { flags, userOverrides } = vi.hoisted(() => ({
  flags: { deal_discovery: true } as Record<string, boolean>,
  userOverrides: { current: {} as Record<string, unknown> },
}));

vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: (key: string) => flags[key] ?? false }));
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({
    state: {
      status: 'ready',
      data: {
        user: {
          id: 'u-1',
          email: 'md@bank.test',
          firm_role: null,
          department: null,
          is_external: false,
          company_id: 'c-1',
          company_role: null,
          ...userOverrides.current,
        },
        mandate: null,
      },
    },
  }),
}));

const fetchMock = vi.fn();

const ELIGIBLE = { eligible: true, consented: false };
const CONSENTED = { eligible: true, consented: true, reading: true };

/** The Gmail status reply; the consent reply defaults to consented when the mailbox is connected, else eligible. */
function replyWith(body: unknown, ok = true, consent?: unknown) {
  const consentBody = consent ?? ((body as { connected?: boolean })?.connected === true ? CONSENTED : ELIGIBLE);
  fetchMock.mockImplementation(async (url: string) =>
    url === '/api/v1/discovery/mailbox-consent'
      ? { ok: true, json: async () => consentBody }
      : { ok, json: async () => body },
  );
}

beforeEach(() => {
  flags.deal_discovery = true;
  userOverrides.current = {};
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ConnectGmailBanner', () => {
  it('asks a banker with no mailbox connected to connect their work email', async () => {
    replyWith({ connected: false });
    render(<ConnectGmailBanner perspective="storm" />);
    const banner = await screen.findByRole('status', { name: 'Connect your work email' });
    expect(banner).toHaveTextContent('Conductia finds your deals in your mailbox. Connect it to start the first sync.');
    expect(screen.getByRole('link', { name: 'Connect work email' })).toHaveAttribute('href', CONNECT_GMAIL_HREF);
    expect(CONNECT_GMAIL_HREF).toBe('/settings?section=mail#deal-discovery');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/discovery/mailbox-consent');
    // Not consented: the Google source cannot carry a refusal yet, so it is not asked.
    expect(fetchMock).not.toHaveBeenCalledWith('/api/v1/discovery/google-mailbox');
  });

  // The Settings › Mail card offers no opt-in to these bankers, so the banner never sends them there to connect.
  it.each([
    ['not eligible', { eligible: false, consented: false, reason: 'domain' }],
    ['consented with no Google source (another provider)', { eligible: true, consented: true, reading: true }],
  ])('stays hidden for a banker %s', async (_label, consent) => {
    replyWith({ connected: false }, true, consent);
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden when the consent status cannot be loaded', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'x' }) });
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('names the admin refusal when Google refused the delegation', async () => {
    replyWith({ connected: true, address: 'md@bank.test', delegationRefused: true, state: 'failing' });
    render(<ConnectGmailBanner perspective="storm" />);
    const banner = await screen.findByRole('status', { name: 'Connect your work email' });
    expect(banner).toHaveTextContent("Your firm's IT admin has not granted access to your mailbox.");
    // The member has consented, so the button opens the card's admin step rather than offering a connect.
    expect(screen.getByRole('link', { name: 'See what to do' })).toHaveAttribute('href', '/settings?section=mail#deal-discovery');
    expect(screen.queryByRole('link', { name: 'Connect work email' })).toBeNull();
  });

  it('reads a broken delegation state as the same refusal', async () => {
    replyWith({ connected: true, delegationRefused: false, state: 'delegation_broken' });
    render(<ConnectGmailBanner perspective="storm" />);
    expect(await screen.findByRole('status', { name: 'Connect your work email' })).toHaveTextContent('has not granted access');
  });

  it('stays hidden once the mailbox is connected and healthy', async () => {
    replyWith({ connected: true, address: 'md@bank.test', delegationRefused: false, state: 'up_to_date' });
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  // switched_off and halted beat a lingering delegation error: the member's step is done, the card names the admin's.
  it.each(['switched_off', 'halted'])('stays hidden when the reader is %s, even with a stale delegation error', async (state) => {
    replyWith({ connected: true, address: 'md@bank.test', delegationRefused: true, state });
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['paused', 'waiting', 'not_started', 'reading', 'stale', null])(
    'stays hidden for a connected mailbox in state %s',
    async (state) => {
      replyWith({ connected: true, address: 'md@bank.test', delegationRefused: false, state });
      const { container } = render(<ConnectGmailBanner perspective="storm" />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await Promise.resolve();
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('stays hidden for a consented banker when the Gmail status cannot be loaded', async () => {
    replyWith({ error: 'Could not load Gmail status' }, false, CONSENTED);
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden while the status is loading', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('never asks an external viewer, and never fetches', () => {
    userOverrides.current = { is_external: true };
    replyWith({ connected: false });
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays hidden with deal_discovery off', () => {
    flags.deal_discovery = false;
    replyWith({ connected: false });
    const { container } = render(<ConnectGmailBanner perspective="storm" />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays hidden outside the storm perspective', () => {
    replyWith({ connected: false });
    const { container } = render(<ConnectGmailBanner perspective="external" />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses no em or en dashes in either message', async () => {
    replyWith({ connected: false });
    const first = render(<ConnectGmailBanner perspective="storm" />);
    expect((await screen.findByRole('status')).textContent).not.toMatch(/[–—]/);
    first.unmount();
    replyWith({ connected: true, delegationRefused: true });
    render(<ConnectGmailBanner perspective="storm" />);
    expect((await screen.findByRole('status')).textContent).not.toMatch(/[–—]/);
  });
});
