import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/*
 * Every UI send carries a resolvable deal reference.
 *
 * UI guard only. The outbox route still sends untagged mail without recipient
 * review (handoff E24), so the composer must never hand it a missing or raw
 * reference for an outside send:
 *   1. On a real deal, the POST's dealId is the deal code, trimmed, also when
 *      the page URL carries the deal UUID.
 *   2. No dealRef, or a deal policy GET at 404, with an outside recipient:
 *      Send is disabled, the reason is visible, nothing is POSTed.
 *   3. Only same-domain recipients: Send stays enabled.
 */

const nav = vi.hoisted(() => ({ projectId: ' 9f1c2d3e-0000-4000-8000-000000000001 ' as string }));
vi.mock('next/navigation', () => ({ useParams: () => nav }));

const dealsState = vi.hoisted(() => {
  const listed = [
    {
      id: 'ZEPHY-2026-640',
      uuid: '9f1c2d3e-0000-4000-8000-000000000001',
      code: 'ZEPHY-2026-640',
      codename: 'Project Zephyr',
    },
  ] as Array<Record<string, unknown>>;
  return { listed, deals: listed, loading: false, error: false, reload: () => {} };
});
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return {
    ...actual,
    useDeals: () => ({
      state: { status: 'ready', deals: dealsState.deals },
      deals: dealsState.deals,
      loading: dealsState.loading,
      error: dealsState.error,
      reload: () => dealsState.reload(),
    }),
  };
});

import { SessionProvider } from '@/lib/session/store';
import { MailComposer } from '@/components/mail/MailComposer';
import { MailClient } from '@/components/mail/MailClient';
import { NOT_ON_DEAL_COPY } from '@/components/deals/DealsUnavailable';

const REASON =
  'Conductia could not match this message to a deal, so it cannot check the recipients. Open the deal and try again.';

type Call = { url: string; method: string; body: Record<string, unknown> };

function stubFetch({ dealStatus = 200 }: { dealStatus?: number } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method, body: init?.body ? JSON.parse(init.body as string) : {} });
      if (u.startsWith('/api/v1/deals/')) {
        return {
          ok: dealStatus === 200,
          status: dealStatus,
          json: async () => ({ deal: { lifecycleCategory: 'closed' } }),
        } as Response;
      }
      if (u.includes('/api/v1/screen')) {
        return { ok: true, json: async () => ({ verdict: 'compliant', reasons: [] }) } as Response;
      }
      if (u.includes('/api/v1/outbox') && method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ message: { id: 'm-1', status: 'sent', reasons: [] } }),
        } as Response;
      }
      if (u.includes('/api/v1/outbox') || u.includes('/api/v1/inbox')) {
        return { ok: true, json: async () => ({ messages: [] }) } as Response;
      }
      if (u.includes('/api/v1/me')) {
        return {
          ok: true,
          json: async () => ({ user: { firm_role: null, is_external: false, email: 'storm@bank.example' } }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
  return calls;
}

const posts = (calls: Call[]) => calls.filter((c) => c.url === '/api/v1/outbox' && c.method === 'POST');

function fill(to: string) {
  fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: to } });
  fireEvent.change(screen.getByLabelText(/^subject$/i), { target: { value: 'Process update' } });
  fireEvent.input(screen.getByLabelText(/^message$/i), { target: { innerHTML: 'The room opens Monday.' } });
}

const send = () => screen.getByRole('button', { name: /^send$/i });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  dealsState.loading = false;
  dealsState.error = false;
  dealsState.reload = () => {};
  dealsState.deals = dealsState.listed;
  nav.projectId = ' 9f1c2d3e-0000-4000-8000-000000000001 ';
});

describe('MailComposer deal guard', () => {
  it('sends the trimmed deal code as dealId on a real deal', async () => {
    const calls = stubFetch();
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} dealRef="  ZEPHY-2026-640 " />
      </SessionProvider>,
    );
    fill('founder@target.com');
    await waitFor(() => expect(send()).toBeEnabled());
    fireEvent.click(send());
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body.dealId).toBe('ZEPHY-2026-640');
    expect(calls.some((c) => c.url === '/api/v1/deals/ZEPHY-2026-640')).toBe(true);
  });

  it('with no dealRef and an outside recipient, Send is disabled with the reason and nothing is posted', async () => {
    const calls = stubFetch();
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} senderEmail="storm@bank.example" />
      </SessionProvider>,
    );
    fill('founder@target.com');
    expect(await screen.findByText(REASON)).toBeInTheDocument();
    expect(send()).toBeDisabled();
    fireEvent.click(send());
    expect(posts(calls)).toHaveLength(0);
  });

  it('with an empty dealRef after trimming, Send is disabled with the reason', async () => {
    const calls = stubFetch();
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} dealRef="   " />
      </SessionProvider>,
    );
    fill('founder@target.com');
    expect(await screen.findByText(REASON)).toBeInTheDocument();
    expect(send()).toBeDisabled();
    expect(calls.some((c) => c.url.startsWith('/api/v1/deals/'))).toBe(false);
  });

  it('with the deal policy GET at 404 and an outside recipient, Send is disabled with the reason', async () => {
    const calls = stubFetch({ dealStatus: 404 });
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} dealRef="sandbox-atlassian" senderEmail="storm@bank.example" />
      </SessionProvider>,
    );
    fill('founder@target.com');
    expect(await screen.findByText(REASON)).toBeInTheDocument();
    expect(send()).toBeDisabled();
    fireEvent.click(send());
    expect(posts(calls)).toHaveLength(0);
  });

  it('with only same-domain recipients, Send stays enabled without a deal', async () => {
    const calls = stubFetch({ dealStatus: 404 });
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} dealRef="sandbox-atlassian" senderEmail="storm@bank.example" />
      </SessionProvider>,
    );
    fill('pat@bank.example, Lee <lee@BANK.example>');
    await screen.findByText(/not linked to a saved deal/i);
    expect(screen.queryByText(REASON)).toBeNull();
    expect(send()).toBeEnabled();
    fireEvent.click(send());
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
  });

  it('a Cc outside the domain blocks a send whose To is same-domain', async () => {
    stubFetch();
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} senderEmail="storm@bank.example" />
      </SessionProvider>,
    );
    fill('pat@bank.example');
    expect(send()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /^cc$/i }));
    fireEvent.change(screen.getByLabelText(/^cc$/i), { target: { value: 'founder@target.com' } });
    expect(await screen.findByText(REASON)).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });
});

describe('MailClient sends the canonical deal code', () => {
  it('a deal UUID in the URL sends the deal code, trimmed', async () => {
    const calls = stubFetch();
    render(
      <SessionProvider>
        <MailClient />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /new message/i }));
    await screen.findByLabelText(/compose email/i);
    fill('founder@target.com');
    await waitFor(() => expect(send()).toBeEnabled());
    fireEvent.click(send());
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body.dealId).toBe('ZEPHY-2026-640');
  });

  it('a listed deal shows the folders and New message (S6R4-02)', async () => {
    stubFetch();
    render(
      <SessionProvider>
        <MailClient />
      </SessionProvider>,
    );
    expect(screen.getByRole('navigation', { name: 'Mail folders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new message/i })).toBeEnabled();
    expect(screen.queryByText(NOT_ON_DEAL_COPY)).toBeNull();
  });

  it('a deal the listing does not hold is the not-on-deal state: no folders, no composer, nothing sent (S6R4-02)', async () => {
    // A firm member who is not on the deal: the inbox route still answers
    // 200 with untagged mail (D65), so the list decides, as on Book.
    nav.projectId = 'not-a-deal';
    const calls = stubFetch();
    render(
      <SessionProvider>
        <MailClient />
      </SessionProvider>,
    );
    expect(await screen.findByText(NOT_ON_DEAL_COPY)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the Conductor Center' })).toHaveAttribute('href', '/projects');
    expect(screen.queryByRole('navigation', { name: 'Mail folders' })).toBeNull();
    expect(screen.queryByRole('button', { name: /new message/i })).toBeNull();
    expect(screen.queryByText('No mail yet.')).toBeNull();
    expect(posts(calls)).toHaveLength(0);
  });

  it('while the deal listing loads, Send waits and no reason shows', async () => {
    dealsState.loading = true;
    dealsState.deals = [];
    stubFetch();
    render(
      <SessionProvider>
        <MailClient />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /new message/i }));
    await screen.findByLabelText(/compose email/i);
    fill('founder@target.com');
    expect(send()).toBeDisabled();
    expect(screen.queryByText(REASON)).toBeNull();
  });
});

// A failed deal listing is stated as that, never as "could not
// match", and an outside send stays blocked.
describe('a failed deal listing', () => {
  const LIST_FAILED = 'Your deal list could not be loaded right now.';

  it('the composer states the failed list with Try again, Send off, and no match reason', async () => {
    const calls = stubFetch();
    const retry = vi.fn();
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} dealRefUnavailable={{ retry }} senderEmail="storm@bank.example" />
      </SessionProvider>,
    );
    fill('founder@target.com');
    expect(await screen.findByText(LIST_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(REASON)).toBeNull();
    expect(send()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(posts(calls)).toHaveLength(0);
  });

  it('same-domain mail still sends while the list is down', async () => {
    stubFetch();
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} dealRefUnavailable={{ retry: () => {} }} senderEmail="storm@bank.example" />
      </SessionProvider>,
    );
    fill('pat@bank.example');
    expect(send()).toBeEnabled();
  });

  it('MailClient passes the failed listing through', async () => {
    dealsState.error = true;
    dealsState.deals = [];
    const reload = vi.fn();
    dealsState.reload = reload;
    stubFetch();
    render(
      <SessionProvider>
        <MailClient />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /new message/i }));
    await screen.findByLabelText(/compose email/i);
    fill('founder@target.com');
    expect(await screen.findByText(LIST_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(REASON)).toBeNull();
    expect(send()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalled();
  });
});
