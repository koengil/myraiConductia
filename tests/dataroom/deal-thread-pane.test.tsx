import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SessionProvider } from '@/lib/session/store';
import { DealThreadPane, replySeed } from '@/components/dataroom/DealThreadPane';

/*
 * The Deal thread pane's reply (#339): Reply opens the platform composer,
 * addressed to the newest message's sender, with a "Re:" subject, a quote of
 * that message, and In-Reply-To and References built from the thread's own
 * Message-IDs.
 */

const message = (n: number, over: Record<string, unknown> = {}) => ({
  sourceItemId: `i-${n}`,
  sentAt: `2026-09-1${n}T15:00:00Z`,
  from: { address: `sender${n}@northwind.example`, name: `Sender ${n}` },
  to: [{ address: 'storm@bank.example', name: 'Storm Duncan' }],
  cc: [],
  subject: 'Project Kestrel',
  body: `Body ${n} <script>`,
  internetMessageId: `<m${n}@northwind.example>`,
  fromSelf: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('replySeed', () => {
  it('answers the newest message: to its sender, Re: subject, an escaped quote and its id for the server', () => {
    const seed = replySeed({ conversationId: null, messages: [message(1), message(2)], replyToken: 'tok.sig' });
    expect(seed).toEqual({
      to: 'sender2@northwind.example',
      subject: 'Re: Project Kestrel',
      bodyHtml: expect.stringContaining('Body 2 &lt;script&gt;'),
      replyToken: 'tok.sig',
    });
    expect(seed?.bodyHtml).not.toContain('<script>');
  });

  it("goes to the recipients of the reader's own newest message, never back to the reader", () => {
    const own = message(2, {
      from: { address: 'storm@bank.example', name: 'Storm Duncan' },
      to: [{ address: 'mike@northwind.example', name: 'Mike' }, { address: 'pat@northwind.example', name: null }],
      fromSelf: true,
    });
    expect(replySeed({ conversationId: null, messages: [message(1), own], replyToken: null })?.to).toBe('mike@northwind.example, pat@northwind.example');
  });

  it('keeps an existing Re: and a [Confidential] marking as they are', () => {
    const seed = replySeed({ conversationId: null, messages: [message(1, { subject: '[Confidential] Re: Project Kestrel' })], replyToken: null });
    expect(seed?.subject).toBe('[Confidential] Re: Project Kestrel');
  });

  it('carries no token when the server issued none, so the reply goes out unthreaded', () => {
    expect(replySeed({ conversationId: null, messages: [message(1)], replyToken: null })).not.toHaveProperty('replyToken');
  });

  it('has nothing to answer in an empty thread', () => {
    expect(replySeed({ conversationId: null, messages: [], replyToken: null })).toBeNull();
  });
});

describe('DealThreadPane reply', () => {
  it('opens the composer prefilled to the newest sender, and Discard closes it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/v1/discovery/deal-email/thread')) {
          return { ok: true, status: 200, json: async () => ({ conversationId: null, messages: [message(1), message(2)], replyToken: 'tok.sig' }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    render(
      <SessionProvider>
        <DealThreadPane dealCode="KESTR-2026-412" sourceItemId="i-1" onBack={() => {}} />
      </SessionProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    expect((screen.getByLabelText(/^to$/i) as HTMLInputElement).value).toBe('sender2@northwind.example');
    expect((screen.getByLabelText(/^subject$/i) as HTMLInputElement).value).toBe('Re: Project Kestrel');
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^subject$/i)).toBeNull();
  });
});

// The thread reply knows the sender, so the same-domain rule
// works here as it does in Mail.
describe('DealThreadPane reply sender', () => {
  it('lets a reply to a colleague at the sender\'s own domain send without a matched deal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/v1/discovery/deal-email/thread')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              conversationId: null,
              messages: [message(1, { from: { address: 'pat@bank.example', name: 'Pat' } })],
              replyToken: null,
            }),
          };
        }
        if (url === '/api/v1/me') {
          return { ok: true, status: 200, json: async () => ({ user: { id: 'u-storm', email: 'storm@bank.example', is_external: false }, company: null, mandate: null }) };
        }
        if (url.includes('/api/v1/screen')) return { ok: true, status: 200, json: async () => ({ verdict: 'compliant', reasons: [] }) };
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    render(
      <SessionProvider>
        <DealThreadPane dealCode="NOT-A-LISTED-DEAL" sourceItemId="i-1" onBack={() => {}} />
      </SessionProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Reply' }));
    fireEvent.input(screen.getByLabelText(/^message$/i), { target: { innerHTML: 'Thanks.' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^send$/i })).toBeEnabled());
  });
});
