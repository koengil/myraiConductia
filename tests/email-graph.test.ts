import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeGraphCode,
  graphAuthUrl,
  graphConfigured,
  graphSendAsUser,
  sendViaGraph,
} from '../src/lib/email/graph';
import { decryptTokens, encryptTokens } from '../src/lib/email/tokenCrypto';
import { OperatorCopyError, UpstreamHttpError } from '../src/lib/errors/upstream';

/*
 * Microsoft Graph mailbox connection.
 *
 * Contracts under test:
 *   1. graphConfigured is false until every env var is present.
 *   2. The authorize URL carries client id, redirect, scopes and state.
 *   3. Code exchange normalizes the token response; failures -> null.
 *   4. sendMail maps recipients/body/attachments to the Graph shape and
 *      returns a 'graph' receipt on 202.
 *   5. Tokens roundtrip through AES-256-GCM and never store plaintext
 *      (tokenCrypto, moved out of graph.ts with the same envelope, so blobs
 *      stored before the move still decrypt).
 *   6. sendViaGraph sends through the Microsoft row it is given. Which row,
 *      and that a Google row never reaches Graph, is the dispatcher's
 *      (tests/email-connected-sender.test.ts, #490).
 */

const KEY_HEX = 'a'.repeat(64);

function configure() {
  vi.stubEnv('MS_CLIENT_ID', 'client-1');
  vi.stubEnv('MS_CLIENT_SECRET', 'shh');
  vi.stubEnv('MS_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', KEY_HEX);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('graph configuration and auth url', () => {
  it('is unconfigured until every env var is present', () => {
    vi.stubEnv('MS_CLIENT_ID', '');
    expect(graphConfigured()).toBe(false);
    configure();
    expect(graphConfigured()).toBe(true);
  });

  it('builds the authorize URL with state and scopes', () => {
    configure();
    const url = new URL(graphAuthUrl('state-123'));
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toContain('Mail.Send');
  });
});

describe('token exchange', () => {
  it('normalizes a token response', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3600,
        }),
      }),
    );
    const tokens = await exchangeGraphCode('code-1');
    expect(tokens?.accessToken).toBe('at-1');
    expect(tokens?.refreshToken).toBe('rt-1');
  });

  it('returns null when the exchange fails', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    expect(await exchangeGraphCode('bad')).toBeNull();
  });
});

describe('graphSendAsUser', () => {
  it('maps the message onto the Graph sendMail shape', async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    const receipt = await graphSendAsUser('at-1', {
      to: ['founder@target.com'],
      cc: ['counsel@bank.dev'],
      subject: 'Process update',
      text: 'The room opens Monday.',
      html: '<p>The room opens <strong>Monday</strong>.</p>',
      attachments: [{ filename: 'teaser.pdf', contentBase64: 'aGVsbG8=', contentType: 'application/pdf' }],
    });
    expect(receipt.provider).toBe('graph');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    const payload = JSON.parse(init.body as string);
    expect(payload.message.toRecipients).toEqual([
      { emailAddress: { address: 'founder@target.com' } },
    ]);
    expect(payload.message.body.contentType).toBe('HTML');
    // The message has no From (#490): Graph sends as the signed-in mailbox.
    expect(payload.message).not.toHaveProperty('from');
    expect(payload.message.attachments[0]).toMatchObject({
      name: 'teaser.pdf',
      contentBytes: 'aGVsbG8=',
    });
  });

  it('throws on a Graph error', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'denied' }),
    );
    const failure = await graphSendAsUser('at-1', {
      to: ['a@b.co'],
      subject: 's',
      text: 't',
    }).catch((e: unknown) => e);
    // The status only; the body ('denied') is never carried.
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure).toMatchObject({ provider: 'graph-mail', op: 'sendMail', status: 403 });
    expect((failure as Error).message).toBe('graph-mail sendMail failed: 403');
  });

  it('reconnect failures are operator copy with the same wording', async () => {
    configure();
    const admin = { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) };
    const input = { to: ['a@b.co'], subject: 's', text: 't' };

    for (const tokens of ['not-a-token', null]) {
      const unreadable = await sendViaGraph(admin as never, { id: 'c1', tokens_encrypted: tokens }, input).catch((e: unknown) => e);
      expect(unreadable).toBeInstanceOf(OperatorCopyError);
      expect((unreadable as Error).message).toBe('Mailbox connection unreadable; reconnect the mailbox');
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }));
    const stored = encryptTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const expired = await sendViaGraph(admin as never, { id: 'c1', tokens_encrypted: stored }, input).catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(OperatorCopyError);
    expect((expired as Error).message).toBe('Mailbox connection expired; reconnect the mailbox');
  });
});

describe('sendViaGraph', () => {
  it('refreshes, re-stores the rotated tokens on the row and sends', async () => {
    configure();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/oauth2/v2.0/token')) {
        return { ok: true, json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }) };
      }
      return { ok: true, status: 202 };
    });
    vi.stubGlobal('fetch', fetchMock);
    const updates: Array<{ payload: Record<string, unknown>; id: unknown }> = [];
    const admin = {
      from: () => ({
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, id: unknown) => {
            updates.push({ payload, id });
            return { error: null };
          },
        }),
      }),
    };
    const stored = encryptTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const receipt = await sendViaGraph(admin as never, { id: 'c1', tokens_encrypted: stored }, { to: ['a@b.co'], subject: 's', text: 't' });
    expect(receipt.provider).toBe('graph');
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('c1');
    expect(decryptTokens<{ refreshToken: string }>(String(updates[0].payload.tokens_encrypted))?.refreshToken).toBe('rt-2');
  });
});

describe('token encryption', () => {
  it('roundtrips and never stores plaintext', () => {
    configure();
    const tokens = { accessToken: 'at-secret', refreshToken: 'rt-secret', expiresAt: 123 };
    const stored = encryptTokens(tokens);
    expect(stored).not.toContain('at-secret');
    expect(stored).not.toContain('rt-secret');
    expect(decryptTokens(stored)).toEqual(tokens);
  });

  it('decrypts a blob in the stored envelope, base64(iv | tag | ciphertext), as written before the move', () => {
    configure();
    const tokens = { accessToken: 'at-legacy', refreshToken: 'rt-legacy', expiresAt: 42 };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY_HEX, 'hex'), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
    expect(decryptTokens(legacy)).toEqual(tokens);
  });

  it('carries any payload shape, such as a refresh token alone', () => {
    configure();
    const stored = encryptTokens({ refreshToken: 'rt-only' });
    expect(stored).not.toContain('rt-only');
    expect(decryptTokens<{ refreshToken: string }>(stored)).toEqual({ refreshToken: 'rt-only' });
  });

  it('returns null under a different key', () => {
    configure();
    const stored = encryptTokens({ refreshToken: 'r' });
    vi.stubEnv('MAILBOX_TOKEN_KEY', 'b'.repeat(64));
    expect(decryptTokens(stored)).toBeNull();
  });

  it('returns null for a tampered blob', () => {
    configure();
    const stored = encryptTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
    const tampered = stored.slice(0, -4) + 'AAAA';
    expect(decryptTokens(tampered)).toBeNull();
  });
});
