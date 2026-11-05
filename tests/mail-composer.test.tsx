import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { SessionProvider } from '../src/lib/session/store';
import { MailComposer } from '../src/components/mail/MailComposer';

/*
 * MailComposer — the compose pane of the Outlook-style mail client.
 *
 * Contracts under test:
 *   1. Renders To / Subject / Message (rich), the formatting toolbar, Cc/Bcc
 *      toggles and Send / Discard.
 *   2. Layer 1 (as you type): the fast screen flags risky wording inline;
 *      advisory only, Send stays enabled.
 *   3. Layer 2 (on send): status 'sent' -> receipt, fields cleared; the POST
 *      carries the screened plain text AND the rich html.
 *   4. status 'held' -> hold notice, draft preserved.
 *   5. status 'blocked' -> blocked notice with the rewrite, draft preserved.
 */

type FetchStub = {
  deal?: { status?: number; category?: string };
  screen?: { verdict: string; reasons: string[]; rewrite?: string };
  outbox?: {
    status: number;
    message?: Record<string, unknown>;
    error?: string;
    /** Raw response body override (e.g. the #158 softHold shape). */
    json?: Record<string, unknown>;
  };
};

function stubFetch({ screen: screenResult, outbox, deal }: FetchStub) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body as string) : {} });
    if (u.startsWith('/api/v1/deals/')) {
      // Default: a saved deal whose lifecycle needs no [Confidential] label, so
      // the deal guard lets an outside send through.
      return { ok: (deal?.status ?? 200) === 200, status: deal?.status ?? 200, json: async () => ({ deal: { lifecycleCategory: deal?.category ?? 'closed' } }) } as Response;
    }
    if (u.includes('/api/v1/mail-domain-policy')) return { ok: true, json: async () => ({ verifiedDomains: ['bank.example'] }) } as Response;
    if (u.includes('/api/v1/screen')) {
      return {
        ok: true,
        json: async () => ({ mode: 'fast', llmChecked: false, verdict: 'compliant', reasons: [], ...screenResult }),
      } as Response;
    }
    if (u.includes('/api/v1/outbox')) {
      return {
        ok: (outbox?.status ?? 201) < 400,
        status: outbox?.status ?? 201,
        json: async () =>
          outbox?.json ?? (outbox?.message ? { message: outbox.message } : { error: outbox?.error }),
      } as Response;
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}

/** On a saved deal (every send carries one), once its policy read settled. */
async function renderComposer() {
  const view = render(
    <SessionProvider>
      <MailComposer screenDebounceMs={0} dealRef="ZZ-TEST-1" />
    </SessionProvider>,
  );
  await screen.findByLabelText('Email subject preview');
  return view;
}

function messageBox() {
  return screen.getByLabelText(/^message$/i) as HTMLDivElement;
}

function fillDraft(body = 'The room opens Monday.') {
  fireEvent.change(screen.getByLabelText(/^to$/i), {
    target: { value: 'founder@target.com' },
  });
  fireEvent.change(screen.getByLabelText(/^subject$/i), {
    target: { value: 'Process update' },
  });
  fireEvent.input(messageBox(), { target: { innerHTML: body } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MailComposer', () => {
  it('renders the compose fields, toolbar, Cc/Bcc toggles and actions', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    expect(screen.getByLabelText(/^to$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^subject$/i)).toBeInTheDocument();
    expect(messageBox()).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: /formatting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /bold/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();

    // Cc reveals its field on demand, Outlook-style.
    fireEvent.click(screen.getByRole('button', { name: /^cc$/i }));
    expect(screen.getByLabelText(/^cc$/i)).toBeInTheDocument();
  });

  it('flags risky wording as you type, advisory only', async () => {
    stubFetch({
      screen: {
        verdict: 'blocked',
        reasons: ['Promissory language to a counterparty.'],
        rewrite: 'Replace "guarantee" with "we expect to".',
      },
    });
    await renderComposer();
    fillDraft('I guarantee the board seat stays');

    await waitFor(() =>
      expect(screen.getByText(/promissory language/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/we expect to/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });

  it('lexicon Tier-1 signals surface as an advisory strip — no Keep, no gate (#163)', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    // "text me" is a Tier-1 lexicon phrase but NOT a Layer-1 rule hit: it
    // must appear in the advisory strip and nowhere near a sign-off.
    fillDraft('Ok, text me when the docs land.');

    const strip = await screen.findByLabelText('Vocabulary signals');
    expect(strip.textContent).toContain('advisory, never blocks');
    expect(strip.textContent).toContain('text me');
    expect(screen.queryByRole('button', { name: /keep/i })).toBeNull();
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });

  it('the strip glosses each signal with its lexicon category (#163 slice 5)', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    fillDraft('Ok, text me when the docs land.');
    const strip = await screen.findByLabelText('Vocabulary signals');
    expect(strip.textContent).toContain('“text me” (Off-channel)');
  });

  it('two signals read as two: each gloss is parenthesised, the item separator stays " · "', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    fillDraft('Please text me once you backdate the cover note.');
    const strip = await screen.findByLabelText('Vocabulary signals');
    expect(strip.textContent).toContain('“backdate” (Books and records)');
    expect(strip.textContent).toContain('“text me” (Off-channel)');
    // The gloss closes before the item separator: ") · “" — never "… · Off-channel · “".
    expect(strip.textContent).toMatch(/\) · “/);
  });

  it('a Tier-2 phrase alone never reaches the sender: no strip, no underline (surfacing doctrine)', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    // "take this offline" is Tier 2 — review with context, supervision-side.
    fillDraft("Let's take this offline and regroup tomorrow.");
    expect(screen.queryByLabelText('Vocabulary signals')).toBeNull();
  });

  it('a clean draft shows no vocabulary strip', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    fillDraft('The data room index was updated this morning.');
    expect(screen.queryByLabelText('Vocabulary signals')).toBeNull();
  });

  it('nested lexicon entries list once — the most specific match wins', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    // "guaranteed" AND "guaranteed allocation" are both Tier-1 entries; one
    // occurrence in the draft must read as ONE signal, not two.
    fillDraft('The guaranteed allocation is set.');

    const strip = await screen.findByLabelText('Vocabulary signals');
    expect(strip.textContent).toContain('guaranteed allocation');
    expect(strip.textContent?.match(/guaranteed/g)?.length).toBe(1);
  });

  it("a longer subject match never discards the body's own shorter occurrence", async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    fillDraft('This is guaranteed.');
    fireEvent.change(screen.getByLabelText(/^subject$/i), {
      target: { value: 'Re: guaranteed allocation' },
    });

    const strip = await screen.findByLabelText('Vocabulary signals');
    // Specificity collapses WITHIN a field only: the body's "guaranteed"
    // survives beside the subject's "guaranteed allocation".
    expect(strip.textContent).toContain('“guaranteed”');
    expect(strip.textContent).toContain('guaranteed allocation');
  });

  it('a rule chip on a fragment does not suppress the broader lexicon signal', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    // The rule pack chips "$200M" (MNPI figure); the Tier-1 lexicon signal
    // "Make the model support $200M" (reverse-engineering doctrine) is a
    // DISTINCT concern and must still surface.
    fillDraft('Make the model support $200M today.');

    const strip = await screen.findByLabelText('Vocabulary signals');
    expect(strip.textContent).toContain('Make the model support $200M');
    expect(screen.getByRole('button', { name: /keep "\$200M"/i })).toBeInTheDocument();
  });

  it('sends the screened plain text plus the rich html, then clears', async () => {
    const { calls } = stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 201,
        message: { id: 'msg-1', status: 'sent', verdict: 'compliant', reasons: [] },
      },
    });
    await renderComposer();
    fillDraft('The room opens <strong>Monday</strong>.');
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/delivered to the provider/i)).toBeInTheDocument());
    const sendCall = calls.find((c) => c.url.includes('/api/v1/outbox'));
    expect(sendCall?.body).toMatchObject({
      to: ['founder@target.com'],
      subject: 'Process update',
      body: 'The room opens Monday.',
    });
    expect(String(sendCall?.body.html)).toContain('<strong>Monday</strong>');
    expect(messageBox().innerHTML).toBe('');
  });

  it('a retry of the same message reuses its clientRequestId; an edit gets a new one', async () => {
    const { calls } = stubFetch({ outbox: { status: 502, error: 'Provider unavailable' } });
    await renderComposer();
    fillDraft();
    const keys = () =>
      calls.filter((c) => c.url === '/api/v1/outbox').map((c) => c.body.clientRequestId as string);
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText('Provider unavailable')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(keys()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    fireEvent.input(messageBox(), { target: { innerHTML: 'The room opens Tuesday.' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(keys()).toHaveLength(3));
    const [first, retry, edited] = keys();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(retry).toBe(first);
    expect(edited).not.toBe(first);
  });

  it('after a send, the identical message sent again carries a new clientRequestId', async () => {
    const { calls } = stubFetch({
      outbox: { status: 201, message: { id: 'msg-1', status: 'sent', verdict: 'compliant', reasons: [] } },
    });
    await renderComposer();
    const keys = () =>
      calls.filter((c) => c.url === '/api/v1/outbox').map((c) => c.body.clientRequestId as string);
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(messageBox().innerHTML).toBe(''));
    fillDraft();
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(keys()).toHaveLength(2));
    expect(keys()[1]).not.toBe(keys()[0]);
  });

  it('tags the send with the active project (dealRef -> dealId in the POST body)', async () => {
    const { calls } = stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 201,
        message: { id: 'msg-t1', status: 'sent', verdict: 'compliant', reasons: [] },
      },
    });
    render(
      <SessionProvider>
        <MailComposer screenDebounceMs={0} dealRef="zephy-2026-640" />
      </SessionProvider>,
    );
    fillDraft();
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/delivered to the provider/i)).toBeInTheDocument());
    const sendCall = calls.find((c) => c.url.includes('/api/v1/outbox'));
    expect(sendCall?.body.dealId).toBe('zephy-2026-640');
  });

  it('a reply seed echoes its reply token in the POST; a new message carries none (#339)', async () => {
    const { calls } = stubFetch({
      outbox: { status: 201, message: { id: 'msg-r1', status: 'sent', verdict: 'compliant', reasons: [] } },
    });
    render(
      <SessionProvider>
        <MailComposer
          screenDebounceMs={0}
          dealRef="ZZ-TEST-1"
          seed={{ to: 'founder@target.com', subject: 'Re: Process update', replyToken: 'tok.sig' }}
        />
      </SessionProvider>,
    );
    fireEvent.input(messageBox(), { target: { innerHTML: 'Thanks, Monday works.' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText(/delivered to the provider/i)).toBeInTheDocument());
    const reply = calls.find((c) => c.url === '/api/v1/outbox');
    expect(reply?.body).toMatchObject({ replyToken: 'tok.sig' });
    expect(reply?.body).not.toHaveProperty('inReplyTo');

    cleanup();
    const fresh = stubFetch({
      outbox: { status: 201, message: { id: 'msg-n1', status: 'sent', verdict: 'compliant', reasons: [] } },
    });
    await renderComposer();
    fillDraft();
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText(/delivered to the provider/i)).toBeInTheDocument());
    const sent = fresh.calls.find((c) => c.url === '/api/v1/outbox');
    expect(sent?.body).not.toHaveProperty('replyToken');
  });

  it('surfaces a hold without sending and preserves the draft', async () => {
    stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 201,
        message: {
          id: 'msg-2',
          status: 'held',
          verdict: 'hold',
          reasons: ['Contains MNPI. Routed to supervisory queue, not blocked.'],
        },
      },
    });
    await renderComposer();
    fillDraft('Our internal model floors this at $510M');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    // Unacknowledged Layer 1 hits -> the confirmation modal gates the send.
    fireEvent.click(screen.getByRole('button', { name: /acknowledge .*and send/i }));

    await waitFor(() =>
      expect(screen.getAllByText(/supervisory/i).length).toBeGreaterThan(0),
    );
    expect(messageBox().textContent).toBe('Our internal model floors this at $510M');
  });

  it('surfaces a block with the rewrite and preserves the draft', async () => {
    stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 201,
        message: {
          id: 'msg-3',
          status: 'blocked',
          verdict: 'blocked',
          reasons: ['Promissory language to a counterparty.'],
          rewrite: 'Replace "guarantee" with a non-binding alternative.',
        },
      },
    });
    await renderComposer();
    fillDraft('I guarantee the price');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.click(screen.getByRole('button', { name: /acknowledge and send/i }));

    await waitFor(() => expect(screen.getByText(/not sent/i)).toBeInTheDocument());
    // The receipt's rewrite, not the closing sign-off dialog's rule note.
    expect(screen.getByText('Replace "guarantee" with a non-binding alternative.')).toBeInTheDocument();
    expect(messageBox().textContent).toBe('I guarantee the price');
  });

  it('Send is disabled until recipient, subject and body exist (no silent clicks)', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    fillDraft();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled();
  });

  it('a flagged term surfaces as a chip; Keep signs it off and Send goes straight through', async () => {
    const { calls } = stubFetch({
      screen: { verdict: 'blocked', reasons: ['Promissory'], rewrite: 'x' },
      outbox: {
        status: 201,
        message: { id: 'm-1', status: 'blocked', verdict: 'blocked', reasons: [] },
      },
    });
    await renderComposer();
    fillDraft('I guarantee the price');

    // The chip carries the matched term and a one-click override.
    const list = screen.getByRole('list', { name: /flagged terms/i });
    expect(list).toHaveTextContent(/i guarantee/i);
    fireEvent.click(screen.getByRole('button', { name: /keep "i guarantee" as written/i }));

    // One action suffices (Storm): no modal after the sign-off.
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/v1/outbox'))).toBe(true),
    );
  });

  it('sign-offs do not carry over into the next message after a send', async () => {
    stubFetch({
      screen: { verdict: 'blocked', reasons: ['Promissory'], rewrite: 'x' },
      outbox: {
        status: 201,
        message: { id: 'm-3', status: 'sent', verdict: 'compliant', reasons: [] },
      },
    });
    await renderComposer();
    fillDraft('I guarantee the price');
    fireEvent.click(screen.getByRole('button', { name: /keep "i guarantee" as written/i }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() =>
      expect(screen.getByText(/delivered to the provider/i)).toBeInTheDocument(),
    );

    // The next message re-asks for the same term: the chip is pending
    // ("Keep …"), not inherited as kept ("Reconsider …").
    fillDraft('I guarantee delivery by Friday');
    expect(
      screen.getByRole('button', { name: /keep "i guarantee" as written/i }),
    ).toBeInTheDocument();
  });

  it('Escape closes the confirmation dialog without sending', async () => {
    const { calls } = stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    fillDraft('I guarantee the price');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    expect(screen.getByRole('dialog', { name: /flagged terms/i })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    // The overlay Dialog plays its exit before it unmounts.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.url.includes('/api/v1/outbox'))).toBe(false);
  });

  it('a hit never spans two fields (subject ending "we" + body starting "Guarantee")', async () => {
    stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/^subject$/i), { target: { value: 'The terms we' } });
    fireEvent.input(messageBox(), { target: { innerHTML: 'Guarantee periods apply' } });
    // Joined screening would mint the phantom term "we\n\nguarantee" here.
    expect(screen.queryByRole('list', { name: /flagged terms/i })).not.toBeInTheDocument();
  });

  it('kept terms ride in the POST as preApproved (#156)', async () => {
    const { calls } = stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 201,
        message: { id: 'm-pa', status: 'blocked', verdict: 'blocked', reasons: [] },
      },
    });
    await renderComposer();
    fillDraft('I guarantee the price');
    fireEvent.click(screen.getByRole('button', { name: /keep "i guarantee" as written/i }));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/v1/outbox'))).toBe(true),
    );
    const sendCall = calls.find((c) => c.url.includes('/api/v1/outbox'));
    expect(sendCall?.body.preApproved).toEqual(['i guarantee']);
  });

  it('terms acknowledged via the confirmation modal ride in the SAME send (#156)', async () => {
    const { calls } = stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 201,
        message: { id: 'm-modal', status: 'held', verdict: 'hold', reasons: [] },
      },
    });
    await renderComposer();
    fillDraft('I guarantee the price');
    // No chip sign-off: Send arms the confirmation modal instead.
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /acknowledge and send/i }));

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/v1/outbox'))).toBe(true),
    );
    const sendCall = calls.find((c) => c.url.includes('/api/v1/outbox'));
    // The state update and the send happen in one click; the fresh sign-off
    // set must reach the POST (a stale closure here silently dropped it).
    expect(sendCall?.body.preApproved).toEqual(['i guarantee']);
  });

  it('the confirmation modal lists pending terms; Back to editing does not send', async () => {
    const { calls } = stubFetch({ screen: { verdict: 'compliant', reasons: [] } });
    await renderComposer();
    fillDraft('I guarantee the price');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    const dialog = screen.getByRole('dialog', { name: /flagged terms/i });
    expect(dialog).toHaveTextContent(/i guarantee/i);
    fireEvent.click(screen.getByRole('button', { name: /back to editing/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((c) => c.url.includes('/api/v1/outbox'))).toBe(false);
    // The draft is untouched.
    expect(messageBox().textContent).toBe('I guarantee the price');
  });

  it('risk issues open the Risk Patcher dialog with heat and diff (#192)', async () => {
    stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 200,
        json: {
          riskIssues: {
            reasons: ['Disparaging remark about the counterparty CFO.'],
            rewrite: 'Honestly their CFO seemed to struggle with the numbers.',
            heat: 58,
          },
        },
      },
    });
    await renderComposer();
    fillDraft('Honestly their CFO is a clown.');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    const dialog = await screen.findByRole('dialog', { name: /risk issues/i });
    expect(dialog).toHaveTextContent(/disparaging remark/i);
    expect(dialog).toHaveTextContent('58/100');
    expect(dialog).toHaveTextContent(/struggle/);
    // Ephemeral by design: the copy says so.
    expect(dialog).toHaveTextContent(/shown now, saved never/i);
  });

  it.each([
    ['mnpi', 'MNPI'],
    ['reputational', 'Front-page test'],
    [undefined, null],
  ])('the risk badge for cause %s reads %s once, and not at all for the generic cause', async (cause, badge) => {
    stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: { status: 200, json: { riskIssues: { reasons: ['A reason.'], rewrite: null, heat: 40, token: 'tok-1', cause } } },
    });
    await renderComposer();
    fillDraft('Draft.');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    const dialog = await screen.findByRole('dialog', { name: /risk issues/i });
    if (badge) expect(within(dialog).getAllByText(badge)).toHaveLength(1);
    else expect(within(dialog).queryByText(/^(MNPI|Front-page test)$/)).toBeNull();
    // The title says "Risk issues" once; the badge does not repeat it.
    expect(within(dialog).queryByText(/^Risk issues ·/)).toBeNull();
  });

  it('the Risk Patcher dialog lists every reason, not just the first', async () => {
    stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 200,
        json: {
          riskIssues: {
            reasons: [
              'Promissory language to a counterparty. Rewrite suggested before send.',
              'Attachment 1 was not screened: it is password protected. Review it before sending.',
              'Attachment 2 was not screened: its file type cannot be read. Review it before sending.',
            ],
            rewrite: null,
            heat: null,
            token: 'tok-1',
          },
        },
      },
    });
    await renderComposer();
    fillDraft('Files attached.');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    const dialog = await screen.findByRole('dialog', { name: /risk issues/i });
    expect(dialog).toHaveTextContent(/promissory language/i);
    expect(dialog).toHaveTextContent(/attachment 1 was not screened/i);
    expect(dialog).toHaveTextContent(/attachment 2 was not screened/i);
  });

  it('"Send as-is" re-sends with the audited send-as-is choice', async () => {
    const { calls } = stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 200,
        json: {
          riskIssues: { reasons: ['Front-page risk.'], rewrite: null, heat: 40, token: 'tok-1' },
        },
      },
    });
    await renderComposer();
    fillDraft('Honestly their CFO is a clown.');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /send as-is/i }));

    await waitFor(() => {
      const sends = calls.filter((c) => c.url.includes('/api/v1/outbox'));
      expect(sends.length).toBe(2);
      expect(sends[1].body.sendAsIs).toBe(true);
      // Bound to the exact screen the sender saw.
      expect(sends[1].body.overrideToken).toBe('tok-1');
    });
  });

  it('"Fix the risk issues and send" replaces the body and re-sends the rewrite', async () => {
    const { calls } = stubFetch({
      screen: { verdict: 'compliant', reasons: [] },
      outbox: {
        status: 200,
        json: {
          riskIssues: {
            reasons: ['Front-page risk.'],
            rewrite: 'Their CFO seemed to struggle with the numbers.',
            heat: 30,
          },
        },
      },
    });
    await renderComposer();
    fillDraft('Honestly their CFO is a clown.');
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /fix the risk issues and send/i }),
    );

    await waitFor(() => {
      const sends = calls.filter((c) => c.url.includes('/api/v1/outbox'));
      expect(sends.length).toBe(2);
      expect(sends[1].body.body).toBe('Their CFO seemed to struggle with the numbers.');
      expect(sends[1].body.overrideReputational).toBeUndefined();
    });
    expect(messageBox().textContent).toContain('struggle');
  });

  it('the typing advisory collapses once a send receipt exists (twin cards fix)', async () => {
    stubFetch({
      screen: {
        verdict: 'blocked',
        reasons: ['Promissory language to a counterparty.'],
        rewrite: 'x',
      },
      outbox: {
        status: 201,
        message: { id: 'm-h', status: 'held', verdict: 'hold', reasons: ['Held reason.'] },
      },
    });
    await renderComposer();
    fillDraft();
    await waitFor(() =>
      expect(screen.getByText(/promissory language/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText(/routed to supervisory review/i)).toBeInTheDocument());
    // One card, not twins: the receipt replaced the typing advisory.
    expect(screen.queryByText(/promissory language/i)).not.toBeInTheDocument();
  });

  it('editing after a receipt clears it and revives the live advisory', async () => {
    stubFetch({
      screen: {
        verdict: 'blocked',
        reasons: ['Promissory language to a counterparty.'],
        rewrite: 'x',
      },
      outbox: {
        status: 201,
        message: { id: 'm-h2', status: 'held', verdict: 'hold', reasons: ['Held reason.'] },
      },
    });
    await renderComposer();
    fillDraft();
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() =>
      expect(screen.getByText(/routed to supervisory review/i)).toBeInTheDocument(),
    );
    // Editing retires the stale receipt; the as-you-type advisory returns.
    fireEvent.input(messageBox(), { target: { innerHTML: 'New risky text' } });
    expect(screen.queryByText(/routed to supervisory review/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/promissory language/i)).toBeInTheDocument(),
    );
  });
});


describe('Confidential preview', () => {
  function composer(dealRef = 'ZZ-TEST-1') {
    return <SessionProvider><MailComposer dealRef={dealRef} screenDebounceMs={0} /></SessionProvider>;
  }
  it.each(['live', 'pitch', 'closed', 'lost', 'prospect', 'mandate_hold', 'terminated'])('previews and sends for %s', async (category) => {
    const { calls } = stubFetch({ deal: { status: 200, category }, outbox: { status: 201, message: { id: 'm', status: 'sent', reasons: [] } } });
    render(composer());
    fillDraft();
    const expected = ['live', 'pitch'].includes(category) ? '[Confidential] Process update' : 'Process update';
    await waitFor(() => expect(screen.getByLabelText('Email subject preview')).toHaveTextContent(expected));
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/outbox')?.body.subject).toBe(expected));
  });
  it('keeps the raw subject editable and rejects an oversized marked subject', async () => {
    stubFetch({ deal: { status: 200, category: 'live' } });
    render(composer()); fillDraft();
    await waitFor(() => expect(screen.getByLabelText('Email subject preview')).toHaveTextContent('[Confidential]'));
    expect(screen.getByLabelText(/^subject$/i)).toHaveValue('Process update');
    fireEvent.change(screen.getByLabelText(/^subject$/i), { target: { value: 'x'.repeat(990) } });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^subject$/i), { target: { value: '' } });
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^subject$/i), { target: { value: '[Confidential] Updated' } });
    expect(screen.getByLabelText('Email subject preview')).toHaveTextContent('[Confidential] Updated');
    expect(screen.getByLabelText('Email subject preview').textContent?.match(/Confidential/g)).toHaveLength(1);
  });
  it.each([401, 403, 500])('keeps sending available on lookup error %s (the server marks the subject), with discard and retry', async (status) => {
    const { fetchMock } = stubFetch({ deal: { status } });
    const discard = vi.fn();
    render(<SessionProvider><MailComposer dealRef="ZZ-TEST" onDiscard={discard} /></SessionProvider>);
    fillDraft();
    await screen.findByRole('button', { name: /try again/i });
    expect(screen.getByRole('alert')).toHaveTextContent(/applied automatically on send/i);
    expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled();
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ deal: { lifecycleCategory: 'live' } }) }) as Response);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(discard).toHaveBeenCalledOnce();
  });
  it('ignores a previous project response after navigation', async () => {
    let resolveA!: (value: Response) => void;
    const { fetchMock } = stubFetch({ deal: { status: 200, category: 'closed' } });
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveA = resolve; }));
    const view = render(composer('ZZ-A')); fillDraft();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    view.rerender(composer('ZZ-B'));
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
    await React.act(async () => resolveA({ ok: true, status: 200, json: async () => ({ deal: { lifecycleCategory: 'live' } }) } as Response));
    expect(screen.getByLabelText('Email subject preview')).toHaveTextContent('Process update');
    expect(screen.getByLabelText('Email subject preview')).not.toHaveTextContent('Confidential');
  });
  it('refuses an outside send for a missing sandbox deal (handoff E24)', async () => {
    const { calls } = stubFetch({ deal: { status: 404 } });
    render(composer()); fillDraft();
    await screen.findByText(/could not match this message to a deal/i);
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
    expect(calls.some((c) => c.url === '/api/v1/outbox')).toBe(false);
  });
  it('shows an explicit untagged context for a missing sandbox deal on same-domain mail', async () => {
    stubFetch({ deal: { status: 404 } });
    render(<SessionProvider><MailComposer dealRef="ZZ-TEST-1" senderEmail="storm@target.com" screenDebounceMs={0} /></SessionProvider>);
    fillDraft();
    await screen.findByText(/not linked to a saved deal/i);
    expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled();
  });
});


it('requires a fresh policy when returning to a previously loaded project', async () => {
  const { fetchMock } = stubFetch({ deal: { status: 200, category: 'closed' } });
  const ui = (ref: string) => <SessionProvider><MailComposer dealRef={ref} /></SessionProvider>;
  const view = render(ui('ZZ-A')); fillDraft();
  await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, init) => String(url).startsWith('/api/v1/deals/')
    ? new Promise<Response>(() => {}) : original(url, init));
  view.rerender(ui('ZZ-B'));
  expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  view.rerender(ui('ZZ-A'));
  expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
});

it.each(['To', 'Cc', 'Bcc'])('warns for an external %s while keeping Send enabled', async (field) => {
  stubFetch({screen:{verdict:'compliant',reasons:[]}}); await renderComposer(); fillDraft();
  fireEvent.change(screen.getByLabelText(/^to$/i), {target:{value:'a@bank.example'}});
  if (field !== 'To') fireEvent.click(screen.getByRole('button',{name:field}));
  fireEvent.change(screen.getByLabelText(field,{exact:true}),{target:{value:'b@outside.test'}});
  await screen.findByText('External recipient');
  expect(screen.getByRole('button',{name:/^send$/i})).toBeEnabled();
});

it('requires explicit recipient approval and carries its token on resubmit',async()=>{
 const recipient={field:'to',email:'founder@target.com',boundary:'external',relationship:'counterparty',requiresConfirmation:true,reason:'counterparty'};
 const outbox={status:200,json:{recipientReviewRequired:{recipients:[recipient],token:'approval'}} as Record<string,unknown>};
 const {calls}=stubFetch({outbox});await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));
 await screen.findByRole('dialog',{name:'Review email recipients'});
 expect(calls.filter(c=>c.url==='/api/v1/outbox')).toHaveLength(1);
 outbox.json={message:{id:'sent',status:'sent',reasons:[]}};
 fireEvent.click(screen.getByRole('button',{name:'Approve recipients and continue'}));
 await waitFor(()=>expect(calls.filter(c=>c.url==='/api/v1/outbox')).toHaveLength(2));
 expect(calls.filter(c=>c.url==='/api/v1/outbox')[1].body.recipientApprovalToken).toBe('approval');
 expect(calls.filter(c=>c.url==='/api/v1/outbox')[1].body.sendAsIs).toBeUndefined();
});

it('closes the review dialog when the approved send fails, so the error is readable',async()=>{
 const recipient={field:'to',email:'founder@target.com',boundary:'external',relationship:'counterparty',requiresConfirmation:true,reason:'counterparty'};
 const outbox={status:200,json:{recipientReviewRequired:{recipients:[recipient],token:'approval'}} as Record<string,unknown>};
 stubFetch({outbox});await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));
 await screen.findByRole('dialog',{name:'Review email recipients'});
 outbox.status=500;outbox.json={error:'Recipient review could not be recorded'};
 fireEvent.click(screen.getByRole('button',{name:'Approve recipients and continue'}));
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Review email recipients'})).toBeNull());
 expect(screen.getByText(/could not be recorded/i)).toBeInTheDocument();
});
it('offers post-send addition for the explicitly approved unknown recipient',async()=>{
 const recipient={field:'bcc',email:'new@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'};
 const outbox={status:200,json:{recipientReviewRequired:{recipients:[recipient],token:'approval'}} as Record<string,unknown>};
 stubFetch({outbox});const sent=vi.fn();render(<SessionProvider><MailComposer screenDebounceMs={0} dealRef="ZZ-TEST-1" onSent={sent}/></SessionProvider>);await screen.findByLabelText('Email subject preview');fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));await screen.findByRole('dialog',{name:'Review email recipients'});
 outbox.json={message:{id:'sent',status:'sent',reasons:[]}};
 fireEvent.click(screen.getByRole('button',{name:'Send anyway and add as known recipient'}));
 await waitFor(()=>expect(sent).toHaveBeenCalledWith('sent',[recipient]));
});
it('offers post-send addition only to challenged recipients, not to a confirmed relationship',async()=>{
 const challenged={field:'bcc',email:'new@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'};
 const addressee={field:'to',email:'cfo@client.test',boundary:'external',relationship:'client',requiresConfirmation:false,reason:null};
 const outbox={status:200,json:{recipientReviewRequired:{recipients:[addressee,challenged],token:'approval'}} as Record<string,unknown>};
 stubFetch({outbox});const sent=vi.fn();render(<SessionProvider><MailComposer screenDebounceMs={0} dealRef="ZZ-TEST-1" onSent={sent}/></SessionProvider>);await screen.findByLabelText('Email subject preview');fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));await screen.findByRole('dialog',{name:'Review email recipients'});
 outbox.json={message:{id:'sent',status:'sent',reasons:[]}};
 fireEvent.click(screen.getByRole('button',{name:'Send anyway and add as known recipient'}));
 await waitFor(()=>expect(sent).toHaveBeenCalledWith('sent',[challenged]));
});
it('reports the recipient review as sent after a warning once the approved email goes out',async()=>{
 const recipient={field:'bcc',email:'new@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'};
 const outbox={status:200,json:{recipientReviewRequired:{recipients:[recipient],token:'approval'}} as Record<string,unknown>};
 const {calls}=stubFetch({outbox});await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));await screen.findByRole('dialog',{name:'Review email recipients'});
 outbox.json={message:{id:'sent',status:'sent',reasons:[]}};
 fireEvent.click(screen.getByRole('button',{name:'Send anyway and add as known recipient'}));
 await waitFor(()=>expect(calls.filter(c=>c.url==='/api/v1/mail-warning-outcomes')).toHaveLength(1));
 expect(calls.find(c=>c.url==='/api/v1/mail-warning-outcomes')?.body).toEqual({outcomes:[{kind:'recipient_review',outcome:'sent_after_warning'}]});
});
it('does not count a warned draft the screen held: nothing went out (D80)',async()=>{
 const recipient={field:'bcc',email:'new@outside.test',boundary:'external',relationship:'unassociated',requiresConfirmation:true,reason:'not_on_deal'};
 const outbox={status:200,json:{recipientReviewRequired:{recipients:[recipient],token:'approval'}} as Record<string,unknown>};
 const {calls}=stubFetch({outbox});await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));await screen.findByRole('dialog',{name:'Review email recipients'});
 outbox.json={message:{id:'held',status:'held',reasons:['Possible MNPI']}};
 fireEvent.click(screen.getByRole('button',{name:'Send anyway and add as known recipient'}));
 await waitFor(()=>expect(calls.filter(c=>c.url==='/api/v1/outbox').length).toBeGreaterThanOrEqual(2));
 await screen.findByText(/possible mnpi/i);
 expect(calls.filter(c=>c.url==='/api/v1/mail-warning-outcomes')).toHaveLength(0);
});
it('reports nothing when the composer closes after a Risk Patcher warning without sending (D80)',async()=>{
 const outbox={status:200,json:{riskIssues:{reasons:['Tone'],heat:58,token:'risk'}} as Record<string,unknown>};
 const {calls}=stubFetch({outbox});const view=await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));
 await screen.findByRole('dialog',{name:/risk issues/i});
 view.unmount();
 expect(calls.filter(c=>c.url==='/api/v1/mail-warning-outcomes')).toHaveLength(0);
});
it('does not count the advisory shown while typing: only send-time warnings are reported',async()=>{
 const {calls}=stubFetch({screen:{verdict:'blocked',reasons:['Promissory language to a counterparty.']}});
 const view=await renderComposer();fillDraft('I guarantee the board seat stays');
 await screen.findByText(/promissory language/i);
 view.unmount();
 expect(calls.filter(c=>c.url==='/api/v1/mail-warning-outcomes')).toHaveLength(0);
});
it('shows renewed recipient confirmation for the AI-rewritten body',async()=>{
 const recipient={field:'to',email:'founder@target.com',boundary:'external',relationship:'counterparty',requiresConfirmation:true,reason:'counterparty'};
 const outbox={status:200,json:{riskIssues:{reasons:['Tone'],rewrite:'The room opens Tuesday.',heat:58,token:'risk'}} as Record<string,unknown>};
 const {calls}=stubFetch({outbox});await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));
 await screen.findByRole('dialog',{name:/risk issues/i});
 outbox.json={recipientReviewRequired:{recipients:[recipient],token:'rewritten-approval'}};
 fireEvent.click(screen.getByRole('button',{name:/fix the risk issues and send/i}));
 await screen.findByRole('dialog',{name:'Review email recipients'});
 outbox.json={message:{id:'sent',status:'sent',reasons:[]}};
 fireEvent.click(screen.getByRole('button',{name:'Approve recipients and continue'}));
 await waitFor(()=>expect(calls.filter(c=>c.url==='/api/v1/outbox')).toHaveLength(3));
 const sent=calls.filter(c=>c.url==='/api/v1/outbox')[2].body;
 expect(sent.body).toBe('The room opens Tuesday.');expect(sent.recipientApprovalToken).toBe('rewritten-approval');
});

// Send friction (Issue #95, D105): a firm on confirm_external asks once before
// a send outside it; the confirmation rides on the resubmit and on any later
// send of the same draft, so a send-as-is does not ask again.
it('asks to confirm an external send, then resubmits with the confirmation',async()=>{
 const outbox={status:409,json:{externalConfirmationRequired:{recipients:['founder@target.com']}} as Record<string,unknown>};
 const {calls}=stubFetch({outbox});await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));
 const dialog=await screen.findByRole('dialog',{name:'Confirm external send'});
 expect(dialog).toHaveTextContent('founder@target.com');
 expect(calls.filter(c=>c.url==='/api/v1/outbox')[0].body.externalConfirmed).toBeUndefined();
 outbox.status=200;outbox.json={message:{id:'sent',status:'sent',reasons:[]}};
 fireEvent.click(screen.getByRole('button',{name:'Confirm and send'}));
 await waitFor(()=>expect(calls.filter(c=>c.url==='/api/v1/outbox')).toHaveLength(2));
 expect(calls.filter(c=>c.url==='/api/v1/outbox')[1].body.externalConfirmed).toBe(true);
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Confirm external send'})).toBeNull());
});
it('sends nothing when the sender goes back from the external confirmation',async()=>{
 const outbox={status:409,json:{externalConfirmationRequired:{recipients:['founder@target.com']}} as Record<string,unknown>};
 const {calls}=stubFetch({outbox});await renderComposer();fillDraft();
 fireEvent.click(screen.getByRole('button',{name:/^send$/i}));
 await screen.findByRole('dialog',{name:'Confirm external send'});
 fireEvent.click(screen.getByRole('button',{name:'Back to editing'}));
 await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Confirm external send'})).toBeNull());
 expect(calls.filter(c=>c.url==='/api/v1/outbox')).toHaveLength(1);
});
