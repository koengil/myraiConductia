import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { formatTime } from '@/lib/format/date';
import { MailboxConsentCard } from '@/components/mail/MailboxConsentCard';

type Status = {
  eligible: boolean;
  reason?: 'no_invite' | 'domain' | 'not_on_a_deal' | null;
  consented: boolean;
  staleConsent?: boolean;
  since?: string | null;
  address?: string;
  reading?: boolean;
  readingReason?: string | null;
};

const ADDRESS = 'storm.duncan@bank.example';
const OFF: Status = { eligible: true, consented: false, address: ADDRESS };
const ON: Status = { eligible: true, consented: true, since: '2026-09-29T10:00:00Z', address: ADDRESS, reading: true, readingReason: null };

const CONNECTED = "You're connected. Conductia reads your mailbox each time it checks for new deals.";

const fetchMock = vi.fn();

function reply(status: number, body?: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const CONSENT = '/api/v1/discovery/mailbox-consent';
const GOOGLE = '/api/v1/discovery/google-mailbox';
const DEALS = '/api/v1/deals';

/**
 * Routes each fetch by URL, so the Gmail step's own request never consumes a
 * reply meant for the consent route. `consent` replies are used in order; the
 * Gmail route answers 404 (no Gmail step) unless `google` says otherwise, and
 * the deal list (the Team link) answers no deals unless `deals` says otherwise.
 * The last `google` and `deals` entries repeat.
 */
function route(
  consent: Response[],
  google: Response[] = [reply(404, { error: 'Not found' })],
  deals: Response[] = [reply(200, { deals: [] })],
) {
  const consentQueue = [...consent];
  const googleQueue = [...google];
  const dealsQueue = [...deals];
  fetchMock.mockImplementation(async (url: string) => {
    const repeats = url === GOOGLE || url === DEALS;
    const queue = url === GOOGLE ? googleQueue : url === DEALS ? dealsQueue : consentQueue;
    const next = queue.length > 1 || !repeats ? queue.shift() : queue[0];
    if (!next) throw new Error(`No reply queued for ${url}`);
    return next;
  });
}

function callsTo(url: string): Array<string> {
  return fetchMock.mock.calls
    .filter((call) => call[0] === url)
    .map((call) => (call[1] as { method?: string } | undefined)?.method ?? 'GET');
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MailboxConsentCard', () => {
  // The status route is never flag-gated (C16), so a 404 is not "the feature is off": it is a failure, and the
  // card says so instead of vanishing.
  it('says the status did not load on 404, instead of hiding', async () => {
    fetchMock.mockResolvedValueOnce(reply(404, { error: 'Not found' }));
    render(<MailboxConsentCard canConnect />);
    expect(await screen.findByText('The change did not save. Try again.')).toBeTruthy();
  });

  it('shows the invite copy for a member with no invite', async () => {
    route([reply(200, { eligible: false, reason: 'no_invite', consented: false })]);
    render(<MailboxConsentCard canConnect />);
    expect(await screen.findByText(/Someone on the deal adds you from its Team page/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  // A member who needs a seat goes straight to a Team page, not to "ask your firm admin".
  it('links a member with no invite to the Team page of a deal they MD, else their first deal', async () => {
    route([reply(200, { eligible: false, reason: 'no_invite', consented: false })], undefined, [
      reply(200, {
        deals: [
          { id: 'd-1', code: 'ALDER-2026-001', codename: 'Project Alder', dealRole: 'deal_team' },
          { id: 'd-2', code: 'BIRCH-2026-002', codename: 'Project Birch', dealRole: 'md' },
        ],
      }),
    ]);
    const { container } = render(<MailboxConsentCard canConnect />);
    const link = await screen.findByRole('link', { name: 'Open the Team page for Project Birch' });
    expect(link.getAttribute('href')).toBe('/projects/BIRCH-2026-002/team');
    expect(container.textContent).not.toMatch(/reader registration|Ask your firm admin/);
  });

  it('links to the first deal when they MD none', async () => {
    route([reply(200, { eligible: false, reason: 'no_invite', consented: false })], undefined, [
      reply(200, { deals: [{ id: 'd-1', codename: 'Project Alder', dealRole: 'deal_team' }] }),
    ]);
    render(<MailboxConsentCard canConnect />);
    expect((await screen.findByRole('link', { name: 'Open the Team page for Project Alder' })).getAttribute('href')).toBe(
      '/projects/d-1/team',
    );
  });

  it.each([
    ['no deals', reply(200, { deals: [] })],
    ['an unreadable deal list', reply(500, { error: 'x' })],
  ])('links to the deal list when there is no deal to name (%s)', async (_label, deals) => {
    route([reply(200, { eligible: false, reason: 'no_invite', consented: false })], undefined, [deals]);
    render(<MailboxConsentCard canConnect />);
    expect((await screen.findByRole('link', { name: 'Open your deals' })).getAttribute('href')).toBe('/projects');
  });

  it('names the admin step and the domain when the address is off the firm domains, with no Team link', async () => {
    route([reply(200, { eligible: false, reason: 'domain', consented: false, address: ADDRESS })]);
    const { container } = render(<MailboxConsentCard canConnect />);
    expect(await screen.findByText(/bank\.example is not one/)).toBeTruthy();
    expect(container.textContent).toContain('Ask your firm admin to add bank.example.');
    expect(screen.queryByRole('link')).toBeNull();
    expect(callsTo(DEALS)).toEqual([]);
  });

  it('still names the admin step for the domain when the status carries no address', async () => {
    route([reply(200, { eligible: false, reason: 'domain', consented: false })]);
    const { container } = render(<MailboxConsentCard canConnect />);
    await screen.findByText(/your firm's mail domains/);
    expect(container.textContent).toContain('your mail domain is not one');
  });

  it('still offers withdrawal to a consented member who is no longer eligible', async () => {
    route([
      reply(200, { eligible: false, reason: 'domain', consented: true, since: '2026-09-29T10:00:00Z', address: ADDRESS }),
    ]);
    render(<MailboxConsentCard canConnect />);
    expect(await screen.findByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
  });

  it('keeps Connect disabled until the box is checked, then POSTs and shows Connected', async () => {
    route([reply(200, OFF), reply(200, ON)]);
    render(<MailboxConsentCard canConnect />);
    const connect = await screen.findByRole('button', { name: 'Connect my mailbox' });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/If you stop later, reading ends and Conductia deletes the mail it stored from your mailbox/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox'));
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(connect);

    expect(await screen.findByText(CONNECTED)).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(callsTo(CONSENT)).toEqual(['GET', 'POST']);
  });

  it('opens a confirm group, cancels it, and DELETEs on Stop reading', async () => {
    route([reply(200, ON), reply(200, OFF)]);
    render(<MailboxConsentCard canConnect />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop reading my mailbox' }));
    const confirm = screen.getByRole('group', { name: 'Stop reading my mailbox' });
    // #461: the confirmation states the deletion, and what stays with a colleague's mailbox.
    expect(confirm.textContent).toContain('Conductia deletes the mail it stored from your mailbox');
    expect(confirm.textContent).toContain("Mail that a colleague's connected mailbox also holds stays with theirs.");
    expect(confirm.textContent).not.toContain('control room keeps');
    expect(confirm.textContent).not.toMatch(/[—–]/);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stop reading my mailbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
    expect(await screen.findByText('Your mailbox is no longer read.')).toBeTruthy();
    expect(callsTo(CONSENT)).toEqual(['GET', 'DELETE']);
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('shows the error status when a POST fails', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, OFF)).mockResolvedValueOnce(reply(500, { error: 'x' }));
    render(<MailboxConsentCard canConnect />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
    expect(await screen.findByText('The change did not save. Try again.')).toBeTruthy();
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('re-fetches the status when a POST answers 403 not_eligible, and shows the not-eligible copy', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, OFF))
      .mockResolvedValueOnce(reply(403, { error: 'not_eligible' }))
      .mockResolvedValueOnce(reply(200, { eligible: false, reason: 'no_invite', consented: false }));
    render(<MailboxConsentCard canConnect />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
    expect(await screen.findByText(/Someone on the deal adds you from its Team page/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect my mailbox' })).toBeNull();
    expect(screen.queryByText('The change did not save. Try again.')).toBeNull();
    expect(callsTo(CONSENT)).toEqual(['GET', 'POST', 'GET']);
  });

  it('shows the domain copy when the re-fetch after a 403 says the address is off the registered domain', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(200, OFF))
      .mockResolvedValueOnce(reply(403, { error: 'not_eligible' }))
      .mockResolvedValueOnce(reply(200, { eligible: false, reason: 'domain', consented: false, address: ADDRESS }));
    render(<MailboxConsentCard canConnect />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
    expect(await screen.findByText(/bank\.example is not one/)).toBeTruthy();
  });

  // A2: one click is open to the MD and the deal team of a deal. A member on no deal is told so, and Connect is not offered.
  describe('a member who is on no deal (not_on_a_deal)', () => {
    const NO_DEAL: Status = {
      eligible: false,
      reason: 'not_on_a_deal',
      consented: false,
      address: ADDRESS,
      reading: false,
      readingReason: 'not_on_a_deal',
    };

    it('says the member needs a deal and offers no Connect', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, NO_DEAL));
      const { container } = render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText(/MD or on the deal team of a deal/)).toBeTruthy();
      expect(container.textContent).toContain("The deal's MD adds you on its Team page");
      expect(await screen.findByRole('link', { name: /Open/ })).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(container.textContent).not.toContain('—');
    });

    it('re-fetches after a 403 not_eligible and shows the deal copy', async () => {
      fetchMock
        .mockResolvedValueOnce(reply(200, OFF))
        .mockResolvedValueOnce(reply(403, { error: 'not_eligible' }))
        .mockResolvedValueOnce(reply(200, NO_DEAL));
      render(<MailboxConsentCard canConnect />);
      fireEvent.click(await screen.findByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
      expect(await screen.findByText(/MD or on the deal team of a deal/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Connect my mailbox' })).toBeNull();
      expect(screen.queryByText('The change did not save. Try again.')).toBeNull();
    });

    // The role check is a grant-time precondition: a consented member who later leaves every deal is still read.
    it('keeps a consented member connected and able to stop, whatever the deal check says now', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, { ...ON, eligible: false, reason: 'not_on_a_deal' }));
      const { container } = render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText('Connected')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
      expect(container.textContent).not.toContain('deal team of a deal');
    });

    it('shows the deal copy, not Connect, beside a stale consent', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, { ...NO_DEAL, staleConsent: true }));
      render(<MailboxConsentCard canConnect />);
      expect(await screen.findByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
      expect(screen.getByText(/MD or on the deal team of a deal/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Connect my mailbox' })).toBeNull();
    });
  });

  it('keeps the error notice when the 403 is not not_eligible', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, OFF)).mockResolvedValueOnce(reply(403, { error: 'mfa_required' }));
    render(<MailboxConsentCard canConnect />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
    expect(await screen.findByText('The change did not save. Try again.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // C12: an open consent on an older invitation is not consent for the current one. The card must not say
  // Connected, must offer Connect when the member can, and must always offer Stop so the consent stays in sight.
  describe('a consent held on an earlier invitation (staleConsent)', () => {
    const STALE: Status = { eligible: true, consented: false, staleConsent: true, since: null, address: ADDRESS };

    it('is not shown as Connected, offers Connect again, and still offers Stop reading', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, STALE));
      render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText(/Your consent covers an earlier invitation/)).toBeTruthy();
      expect(screen.queryByText('Connected')).toBeNull();
      expect(screen.getByRole('button', { name: 'Connect my mailbox' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
    });

    it('connects again under the current invitation with the same checkbox', async () => {
      route([reply(200, STALE), reply(200, ON)]);
      render(<MailboxConsentCard canConnect />);
      const connect = await screen.findByRole('button', { name: 'Connect my mailbox' });
      expect((connect as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(connect);
      expect(await screen.findByText('Connected')).toBeTruthy();
      expect(callsTo(CONSENT)).toEqual(['GET', 'POST']);
    });

    it('ends the earlier consent with Stop reading, then offers Connect on the fresh status', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, STALE)).mockResolvedValueOnce(reply(200, OFF));
      render(<MailboxConsentCard canConnect />);
      fireEvent.click(await screen.findByRole('button', { name: 'Stop reading my mailbox' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
      expect(await screen.findByText('Your mailbox is no longer read.')).toBeTruthy();
      expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/discovery/mailbox-consent', { method: 'DELETE' });
      expect(screen.queryByText(/Your consent covers an earlier invitation/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Connect my mailbox' })).toBeTruthy();
    });

    it('with no current seat, says reading is paused and offers Stop reading only', async () => {
      fetchMock.mockResolvedValueOnce(
        reply(200, { eligible: false, reason: 'no_invite', consented: false, staleConsent: true, since: null, address: ADDRESS }),
      );
      render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText(/reading is paused/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Connect my mailbox' })).toBeNull();
      expect(screen.queryByText(/Ask your firm admin/)).toBeNull();
    });

    it('with a seat on an unregistered domain, offers Stop reading and the domain step, not Connect', async () => {
      fetchMock.mockResolvedValueOnce(
        reply(200, { eligible: false, reason: 'domain', consented: false, staleConsent: true, since: null, address: ADDRESS }),
      );
      render(<MailboxConsentCard canConnect />);
      expect(await screen.findByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
      expect(screen.getByText(/bank\.example is not one/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Connect my mailbox' })).toBeNull();
    });

    it('with deal_discovery off, shows the stale consent to its owner and offers Stop reading only', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, STALE)).mockResolvedValueOnce(reply(200, { ...OFF }));
      render(<MailboxConsentCard canConnect={false} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Stop reading my mailbox' }));
      expect(screen.queryByRole('button', { name: 'Connect my mailbox' })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
      expect(await screen.findByText('Your mailbox is no longer read.')).toBeTruthy();
    });
  });

  // Item 1 (PR #300 follow-up), and A3 (audit round 3, H2): consent is not reading. `reading` is database
  // eligibility, the guard's own verdict. The card says "You're connected" only when it is true, never promises a
  // pass, and otherwise names the step the guard's reason calls for.
  describe('consent that is not yet reading (reading false)', () => {
    const pending = (readingReason: string): Status => ({ ...ON, reading: false, readingReason });

    it('says "You\'re connected" only when the status says it is reading, and promises no pass', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, OFF)).mockResolvedValueOnce(reply(200, ON));
      const { container } = render(<MailboxConsentCard canConnect />);
      fireEvent.click(await screen.findByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
      expect(await screen.findByText(CONNECTED)).toBeTruthy();
      expect(container.textContent).not.toMatch(/next pass|starts/i);
      expect(container.textContent).not.toContain('\u2014');
    });

    it('on load with reading true, states eligibility, the address and the date, with no promise of a pass', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, ON));
      const { container } = render(<MailboxConsentCard canConnect />);
      await screen.findByText('Connected');
      expect(container.textContent).toContain(CONNECTED);
      expect(container.textContent).toContain(ADDRESS);
      expect(container.textContent).toContain('Sep 29, 2026');
      expect(container.textContent).not.toMatch(/next pass|starts/i);
      expect(container.textContent).not.toContain('\u2014');
    });

    it.each([
      ['owner_mismatch', /set up for reading under someone else at your firm\. Ask your firm admin to assign it to you/],
      ['source_paused', /Your firm admin paused reading for .*Ask them to resume it/],
      ['no_source', /is not set up for reading yet\. Ask your firm admin to set it up/],
      ['registration_inactive', /Reading for .* is switched off at your firm\. Ask your firm admin to switch it on/],
      ['seat_inactive', /Ask your firm admin to check reading for/],
    ])('after Connect with reason %s, names the admin step and does not promise a read', async (reason, step) => {
      fetchMock.mockResolvedValueOnce(reply(200, OFF)).mockResolvedValueOnce(reply(200, pending(reason)));
      const { container } = render(<MailboxConsentCard canConnect />);
      fireEvent.click(await screen.findByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
      await screen.findByText(/Your consent is recorded/);
      expect(container.textContent).not.toContain(CONNECTED);
      expect(container.textContent).toMatch(step);
    });

    it('does not claim to read on load when the consent is recorded but the guard will not read it', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, pending('owner_mismatch')));
      const { container } = render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText(/Ask your firm admin to assign it to you/)).toBeTruthy();
      expect(container.textContent).not.toContain(CONNECTED);
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
    });

    it('does not claim to read when the status carries no readiness', async () => {
      fetchMock.mockResolvedValueOnce(reply(200, { eligible: true, consented: true, since: '2026-09-29T10:00:00Z', address: ADDRESS }));
      const { container } = render(<MailboxConsentCard canConnect />);
      await screen.findByRole('button', { name: 'Stop reading my mailbox' });
      expect(container.textContent).not.toContain(CONNECTED);
    });

    it('never renders an em dash for any reason', async () => {
      for (const reason of ['owner_mismatch', 'source_paused', 'no_source', 'registration_inactive', 'seat_inactive', 'domain']) {
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(reply(200, pending(reason)));
        const { container, unmount } = render(<MailboxConsentCard canConnect />);
        await screen.findByRole('button', { name: 'Stop reading my mailbox' });
        expect(container.textContent).not.toContain('—');
        expect(container.textContent).not.toMatch(/reader|registration/i);
        unmount();
      }
    });
  });

  describe('with deal_discovery off (canConnect is false)', () => {
    it('still offers Stop to a consented member, and withdraws', async () => {
      route([reply(200, ON), reply(200, OFF)]);
      const { container } = render(<MailboxConsentCard canConnect={false} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Stop reading my mailbox' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
      expect(await screen.findByText('Your mailbox is no longer read.')).toBeTruthy();
      expect(callsTo(CONSENT)).toEqual(['GET', 'DELETE']);
      // With the flag off the Gmail step never asks either.
      expect(callsTo(GOOGLE)).toEqual([]);
      // After withdrawing there is nothing left to show: no connect, no eligibility copy.
      expect(screen.queryByRole('button', { name: 'Connect my mailbox' })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(container.textContent).not.toContain('Ask your firm admin');
    });

    it.each([
      ['eligible', OFF],
      ['not eligible', { eligible: false, reason: 'no_invite', consented: false } as Status],
    ])('shows nothing to a member who has not consented (%s)', async (_label, state) => {
      fetchMock.mockResolvedValueOnce(reply(200, state));
      const { container } = render(<MailboxConsentCard canConnect={false} />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(container.innerHTML).toBe('');
    });

    it('shows nothing when the status cannot be read', async () => {
      fetchMock.mockResolvedValueOnce(reply(500, { error: 'x' }));
      const { container } = render(<MailboxConsentCard canConnect={false} />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(container.innerHTML).toBe('');
    });
  });

  // #259: Gmail folds into the one-click opt-in. There is no second connect button: after "Connect my mailbox" a
  // member whose source is Google is told which group to be added to, and the card never says "connected" while the
  // guard refuses the address for the group.
  describe('a Gmail member after the one-click opt-in', () => {
    const GROUP = 'conductia-ingest@bank.example';
    const GMAIL_OK = { connected: true, address: ADDRESS, group: GROUP, domain: 'bank.example', paused: false, waitingForGroup: false };
    const WAITING = { ...GMAIL_OK, waitingForGroup: true };
    const PAUSED = { ...GMAIL_OK, paused: true };
    // The database verdict cannot see group membership, so it can say reading while the group refuses.
    const DB_READING = ON;

    it('asks for the Gmail status only after consent, never before', async () => {
      route([reply(200, OFF)], [reply(200, GMAIL_OK)]);
      render(<MailboxConsentCard canConnect />);
      await screen.findByRole('button', { name: 'Connect my mailbox' });
      expect(screen.queryByRole('heading', { name: 'Gmail' })).toBeNull();
      expect(callsTo(GOOGLE)).toEqual([]);
    });

    it('offers no second connect button', async () => {
      route([reply(200, DB_READING)], [reply(200, GMAIL_OK)]);
      render(<MailboxConsentCard canConnect />);
      await screen.findByRole('heading', { name: 'Gmail' });
      expect(screen.queryByRole('button', { name: /Connect Gmail/ })).toBeNull();
      expect(screen.queryAllByRole('button', { name: /^Connect/ })).toEqual([]);
    });

    it('after Connect my mailbox, shows the group to be added to with its link, apart from the consent controls', async () => {
      route([reply(200, OFF), reply(200, DB_READING)], [reply(200, WAITING)]);
      render(<MailboxConsentCard canConnect />);
      fireEvent.click(await screen.findByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Connect my mailbox' }));
      const heading = await screen.findByRole('heading', { name: 'Gmail' });
      expect(
        screen.getByText(`Ask your Google admin to add you to ${GROUP}. Reading starts on the next check after you are added.`),
      ).toBeTruthy();
      expect(callsTo(CONSENT)).toEqual(['GET', 'POST']);
      expect(callsTo(GOOGLE)).toEqual(['GET']);
      const link = screen.getByRole('link', { name: `Open ${GROUP}` }) as HTMLAnchorElement;
      expect(link.href).toBe('https://groups.google.com/a/bank.example/g/conductia-ingest');
      expect(link.getAttribute('rel')).toContain('noreferrer');
      expect(heading.closest('section')?.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' }).closest('section')).toBeNull();
    });

    it('says waiting, and never connected, while the group refuses the address', async () => {
      route([reply(200, DB_READING)], [reply(200, WAITING)]);
      const { container } = render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText('Waiting to be added to the group')).toBeTruthy();
      expect(screen.queryByText('Connected')).toBeNull();
      expect(container.textContent).not.toContain(CONNECTED);
      expect(container.textContent).not.toMatch(/\breading your mailbox\b|You're connected/);
      expect(screen.getByRole('link', { name: `Open ${GROUP}` })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
    });

    it('with no refusal on record, keeps Connected and states the group requirement with its link', async () => {
      route([reply(200, DB_READING)], [reply(200, GMAIL_OK)]);
      render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText(`Conductia reads your mailbox only while you are in your firm's Google group ${GROUP}.`)).toBeTruthy();
      expect(screen.getByText('Connected')).toBeTruthy();
      expect(screen.queryByText('Waiting to be added to the group')).toBeNull();
      expect(screen.getByRole('link', { name: `Open ${GROUP}` })).toBeTruthy();
    });

    it('shows Paused by your firm when a firm admin paused the source, and no join instruction', async () => {
      route([reply(200, { ...DB_READING, reading: false, readingReason: 'source_paused' })], [reply(200, PAUSED)]);
      render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText('Paused by your firm')).toBeTruthy();
      expect(screen.queryByText('Connected')).toBeNull();
      expect(screen.queryByText('Waiting to be added to the group')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Gmail' })).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it('shows paused over waiting when both are true', async () => {
      route([reply(200, { ...DB_READING, reading: false, readingReason: 'source_paused' })], [reply(200, { ...WAITING, paused: true })]);
      render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText('Paused by your firm')).toBeTruthy();
      expect(screen.queryByText('Waiting to be added to the group')).toBeNull();
    });

    it('shows no Gmail section for a member whose source is not Google', async () => {
      route([reply(200, DB_READING)], [reply(200, { connected: false })]);
      render(<MailboxConsentCard canConnect />);
      await screen.findByText('Connected');
      await waitFor(() => expect(callsTo(GOOGLE)).toEqual(['GET']));
      expect(screen.queryByRole('heading', { name: 'Gmail' })).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    });

    it.each([
      ['the Gmail route is off', reply(404, { error: 'Not found' })],
      ['the Gmail route fails', reply(500, { error: 'x' })],
    ])('keeps the consent card as it was when %s', async (_label, google) => {
      route([reply(200, DB_READING)], [google]);
      render(<MailboxConsentCard canConnect />);
      await screen.findByText('Connected');
      await waitFor(() => expect(callsTo(GOOGLE)).toEqual(['GET']));
      expect(screen.queryByRole('heading', { name: 'Gmail' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
    });

    it('goes away when the member stops reading their mailbox', async () => {
      route([reply(200, DB_READING), reply(200, OFF)], [reply(200, WAITING)]);
      render(<MailboxConsentCard canConnect />);
      await screen.findByRole('heading', { name: 'Gmail' });
      fireEvent.click(screen.getByRole('button', { name: 'Stop reading my mailbox' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
      await screen.findByText('Your mailbox is no longer read.');
      expect(screen.queryByRole('heading', { name: 'Gmail' })).toBeNull();
      expect(screen.queryByText('Waiting to be added to the group')).toBeNull();
    });

    it('keeps both consent disclosure sentences, and never renders an em dash or en dash', async () => {
      route([reply(200, OFF)]);
      const before = render(<MailboxConsentCard canConnect />);
      expect(await screen.findByText(/Colleagues see what it finds only on deals they can already see/)).toBeTruthy();
      expect(screen.getByText(/If you stop later, reading ends and Conductia deletes the mail it stored from your mailbox/)).toBeTruthy();
      before.unmount();

      for (const google of [GMAIL_OK, WAITING, PAUSED, { connected: false }]) {
        fetchMock.mockReset();
        route([reply(200, DB_READING)], [reply(200, google)]);
        const { container, unmount } = render(<MailboxConsentCard canConnect />);
        await screen.findByRole('button', { name: 'Stop reading my mailbox' });
        await waitFor(() => expect(callsTo(GOOGLE)).toEqual(['GET']));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(container.textContent).not.toContain('\u2014');
        expect(container.textContent).not.toContain('\u2013');
        unmount();
      }
    });
  });

  // #341: the member sees their own first sync. The status carries the health state of their own source only.
  describe('the first-sync status of a connected Gmail member', () => {
    const GROUP = 'conductia-ingest@bank.example';
    const BASE = { connected: true, address: ADDRESS, group: GROUP, domain: 'bank.example', paused: false, waitingForGroup: false };
    const NOW = new Date();
    const sync = () => screen.getByLabelText('Gmail sync');

    async function show(google: Record<string, unknown>) {
      route([reply(200, ON)], [reply(200, { ...BASE, ...google })]);
      const view = render(<MailboxConsentCard canConnect />);
      await screen.findByRole('heading', { name: 'Gmail' });
      return view;
    }

    it('says the first sync is starting before any pass', async () => {
      await show({ state: 'not_started' });
      expect(sync().textContent).toBe('First sync starting');
      expect(screen.getByText('Connected')).toBeTruthy();
    });

    it('says the first sync is running during the first full read', async () => {
      await show({ state: 'reading', backfillCompletedAt: null });
      expect(sync().textContent).toBe('First sync running');
    });

    it('says a live pass after the first full read is checking for new mail, never up to date while it runs', async () => {
      await show({ state: 'reading', backfillCompletedAt: '2026-01-15T09:00:00Z', lastSyncedAt: '2026-01-15T09:30:00Z' });
      expect(sync().textContent).toMatch(/^Checking for new mail\. Last synced Jan 15, 2026, \d{1,2}:\d{2} (AM|PM)\.$/);
      expect(screen.queryByText(/Up to date|New mail arrives within minutes/)).toBeNull();
    });

    it('says up to date with the last check and when new mail arrives', async () => {
      await show({ state: 'up_to_date', backfillCompletedAt: NOW.toISOString(), lastSyncedAt: NOW.toISOString() });
      const time = formatTime(NOW);
      expect(screen.getByText(`Up to date, last checked ${time}`)).toBeTruthy();
      expect(screen.getByText('New mail arrives within minutes')).toBeTruthy();
      expect(screen.getByText('Connected')).toBeTruthy();
    });

    it('names the day of a last check before today', async () => {
      await show({ state: 'up_to_date', lastSyncedAt: '2026-01-15T09:30:00Z' });
      expect(sync().textContent).toMatch(/^Up to date, last checked Jan 15, 2026, \d{1,2}:\d{2} (AM|PM)/);
    });

    it('says the mailbox has not been checked recently when the source is stale', async () => {
      await show({ state: 'stale', lastSyncedAt: '2026-01-15T09:30:00Z' });
      expect(sync().textContent).toMatch(
        /^Conductia has not checked your mailbox recently, last checked Jan 15, 2026, \d{1,2}:\d{2} (AM|PM)\. Ask your firm admin to check that reading is running\.$/,
      );
    });

    // A stale check never sits under a green Connected.
    it('a stale source reads "Connected, check delayed" with no success styling, and dates an earlier day', async () => {
      await show({ state: 'stale', lastSyncedAt: '2026-01-15T09:30:00Z' });
      const badge = screen.getByText('Connected, check delayed');
      expect(badge.className).not.toContain('positive');
      expect(screen.queryByText('Connected')).toBeNull();
      expect(sync().textContent).toMatch(/last checked Jan 15, 2026, \d{1,2}:\d{2} (AM|PM)/);
    });

    it('a stale check from today shows the time alone', async () => {
      await show({ state: 'stale', lastSyncedAt: NOW.toISOString() });
      expect(screen.getByText('Connected, check delayed')).toBeTruthy();
      expect(sync().textContent).toContain(`last checked ${formatTime(NOW)}.`);
    });

    it.each([
      ['a delegation_broken state', { state: 'delegation_broken', delegationRefused: true }],
      ['the refusal flag alone', { state: 'failing', delegationRefused: true }],
      ['the state alone', { state: 'delegation_broken' }],
    ])('names the Google admin step, and never shows Connected, for %s', async (_label, google) => {
      const { container } = await show(google);
      expect(screen.getByText("Your firm's Google admin has not granted access")).toBeTruthy();
      expect(screen.getByText(/Ask your firm's Google Workspace admin to give Conductia read access to Gmail \(domain-wide delegation\)/)).toBeTruthy();
      expect(screen.getByText('Access not granted')).toBeTruthy();
      expect(screen.queryByText('Connected')).toBeNull();
      expect(container.textContent).not.toContain(CONNECTED);
      expect(container.textContent).not.toMatch(/Ask your firm admin to check reading for/);
      expect(screen.getByRole('button', { name: 'Stop reading my mailbox' })).toBeTruthy();
    });

    // The reader is off for the firm or stopped for this mailbox: a switch-off beats a lingering delegation error.
    it.each([
      ['switched_off', 'Reading is switched off for your firm', /Reading starts when your firm admin switches it on/],
      ['halted', 'Reading stopped', /Ask your firm admin to restart reading for your mailbox/],
    ])('names the firm admin step, and never shows Connected, when the reader is %s', async (state, line, step) => {
      for (const delegationRefused of [false, true]) {
        fetchMock.mockReset();
        const { container, unmount } = await show({ state, delegationRefused });
        expect(sync().textContent).toMatch(new RegExp(`^${line}`));
        expect(screen.getByText(step)).toBeTruthy();
        expect(screen.getByText('Not reading yet')).toBeTruthy();
        expect(screen.queryByText('Connected')).toBeNull();
        expect(screen.queryByText('Access not granted')).toBeNull();
        expect(container.textContent).not.toMatch(/Up to date|Ask your firm admin to check reading for/);
        unmount();
      }
    });

    it('says the last sync did not finish when the reader is failing', async () => {
      await show({ state: 'failing', delegationRefused: false });
      expect(sync().textContent).toBe(
        'The last sync did not finishConductia tries again on the next check. If it keeps failing, ask your firm admin to check reading.',
      );
    });

    // The lines mount filled and the card never refreshes them, so they are a labelled group, not a live region.
    it('labels the sync lines as a group, without a live region', async () => {
      await show({ state: 'not_started' });
      expect(sync().getAttribute('role')).toBe('group');
      expect(sync().hasAttribute('aria-live')).toBe(false);
    });

    // The picker banner links to Settings › Mail (#deal-discovery).
    it('carries the deal-discovery anchor the picker banner links to', async () => {
      const { container } = await show({ state: 'not_started' });
      const card = container.querySelector('#deal-discovery');
      expect(card).not.toBeNull();
      expect(card).toContainElement(screen.getByRole('heading', { name: 'Deal discovery' }));
    });

    it('shows no sync line for an older status without a state, or while waiting for the group', async () => {
      await show({});
      expect(sync().textContent).toBe('');
      expect(screen.getByText('Connected')).toBeTruthy();
      cleanup();
      fetchMock.mockReset();
      await show({ state: 'waiting', waitingForGroup: true });
      expect(sync().textContent).toBe('');
      expect(screen.getByText('Waiting to be added to the group')).toBeTruthy();
    });

    it('shows no sync line while a firm admin paused the source', async () => {
      route([reply(200, { ...ON, reading: false, readingReason: 'source_paused' })], [reply(200, { ...BASE, paused: true, state: 'paused' })]);
      render(<MailboxConsentCard canConnect />);
      await screen.findByText('Paused by your firm');
      expect(screen.queryByLabelText('Gmail sync')).toBeNull();
    });

    it('never renders an em dash or en dash in any sync state', async () => {
      for (const google of [
        { state: 'not_started' },
        { state: 'reading' },
        { state: 'up_to_date', lastSyncedAt: '2026-01-15T09:30:00Z' },
        { state: 'stale' },
        { state: 'delegation_broken', delegationRefused: true },
        { state: 'switched_off' },
        { state: 'halted' },
        { state: 'failing' },
      ]) {
        fetchMock.mockReset();
        const { container, unmount } = await show(google);
        expect(container.textContent).not.toContain('\u2014');
        expect(container.textContent).not.toContain('\u2013');
        unmount();
      }
    });
  });

  it('never renders an em dash', async () => {
    const states: Status[] = [
      { eligible: false, reason: 'no_invite', consented: false },
      { eligible: false, reason: 'domain', consented: false },
      { eligible: false, reason: 'domain', consented: false, address: ADDRESS },
      { eligible: false, reason: 'not_on_a_deal', consented: false, address: ADDRESS, readingReason: 'not_on_a_deal' },
      { eligible: true, consented: false, staleConsent: true, address: ADDRESS },
      { eligible: false, reason: 'no_invite', consented: false, staleConsent: true, address: ADDRESS },
      OFF,
      ON,
    ];
    for (const state of states) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(reply(200, state));
      const { container, unmount } = render(<MailboxConsentCard canConnect />);
      await waitFor(() => expect(container.querySelector('h3 ~ div')?.textContent).toBeTruthy());
      expect(container.textContent).not.toContain('—');
      unmount();
    }
  });
});
