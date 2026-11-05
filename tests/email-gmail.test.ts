// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkGrantIdentity,
  exchangeGmailCode,
  gmailSendAuthUrl,
  gmailSendConfigured,
  gmailSendRaw,
  pkcePair,
  refreshGmailAccessToken,
  type GmailGrant,
} from '../src/lib/email/gmail';
import { UpstreamHttpError } from '../src/lib/errors/upstream';

/*
 * Gmail send as the banker (#490 S1b): the sending client, dormant until S2b.
 *
 * Contracts under test:
 *   1. gmailSendConfigured is false until all four env vars are present.
 *   2. The authorize URL: PKCE S256, offline, consent, login_hint, hd, exactly openid email gmail.send.
 *   3. The exchange refuses on the grant alone: gmail.send missing, a scope beyond the allowed set,
 *      a bad id_token (aud, iss, exp), no hd. A refusal carries only its reason: nothing is
 *      revoked (#490 audit 1).
 *   4. checkGrantIdentity: verified email equal to the banker's, the bound sub, a firm domain.
 *   5. Refresh classifies every 400 invalid_grant as revoked, client errors as misconfigured, the rest upstream.
 *   6. messages.send is called once, never retried; errors carry a status and a code, never a body.
 */

const CLIENT_ID = 'send-client.apps.example';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const USERINFO_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';
// A provider body that must never surface in a thrown message, a result or a log.
const CANARY = 'CANARY-storm@ignatious.com-Project-Falcon';

function configure() {
  vi.stubEnv('GOOGLE_SEND_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('GOOGLE_SEND_CLIENT_SECRET', 'shh');
  vi.stubEnv('GOOGLE_SEND_REDIRECT_URI', 'http://localhost:3000/api/v1/mailbox/google/callback');
  vi.stubEnv('MAILBOX_TOKEN_KEY', 'a'.repeat(64));
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function idToken(overrides: Record<string, unknown> = {}): string {
  const claims = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'google-sub-1',
    email: 'storm@ignatious.com',
    email_verified: true,
    hd: 'ignatious.com',
    ...overrides,
  };
  return `${b64({ alg: 'RS256' })}.${b64(claims)}.signature`;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => handler(String(url), init ?? {}));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const formOf = (init: RequestInit) => new URLSearchParams(String(init.body));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('configuration, PKCE and the authorize URL', () => {
  it('is unconfigured until every env var is present', () => {
    configure();
    expect(gmailSendConfigured()).toBe(true);
    for (const name of ['GOOGLE_SEND_CLIENT_ID', 'GOOGLE_SEND_CLIENT_SECRET', 'GOOGLE_SEND_REDIRECT_URI', 'MAILBOX_TOKEN_KEY']) {
      vi.stubEnv(name, '');
      expect(gmailSendConfigured(), name).toBe(false);
      configure();
    }
  });

  it('makes an S256 pair with a 43-128 character verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(pkcePair().verifier).not.toBe(verifier);
  });

  it('asks for exactly openid email gmail.send, offline, with consent, PKCE and the hints', () => {
    configure();
    const url = new URL(gmailSendAuthUrl({ state: 's-1', challenge: 'c-1', loginHint: 'storm@ignatious.com', hd: 'ignatious.com' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://localhost:3000/api/v1/mailbox/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe(`openid email ${GMAIL_SEND}`);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe('s-1');
    expect(p.get('code_challenge')).toBe('c-1');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('login_hint')).toBe('storm@ignatious.com');
    expect(p.get('hd')).toBe('ignatious.com');
    expect(p.has('include_granted_scopes')).toBe(false);
  });
});

describe('code exchange and the grant checks', () => {
  const grantResponse = (overrides: Record<string, unknown> = {}) =>
    json({ access_token: 'at-1', refresh_token: 'rt-1', scope: `openid email ${GMAIL_SEND}`, id_token: idToken(), ...overrides });

  it('posts the code, the verifier and the client secret, and returns the grant', async () => {
    configure();
    const fetchMock = stubFetch(() => grantResponse());
    const result = await exchangeGmailCode('code-1', 'verifier-1');
    expect(result).toEqual({
      ok: true,
      grant: {
        refreshToken: 'rt-1',
        email: 'storm@ignatious.com',
        emailVerified: true,
        sub: 'google-sub-1',
        hd: 'ignatious.com',
        scopes: ['email', GMAIL_SEND, 'openid'],
      },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    const form = formOf(init!);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('code-1');
    expect(form.get('code_verifier')).toBe('verifier-1');
    expect(form.get('client_secret')).toBe('shh');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts userinfo.email for email and stores the normalized granted set', async () => {
    configure();
    stubFetch(() => grantResponse({ scope: `${GMAIL_SEND}  openid ${USERINFO_EMAIL} ${GMAIL_SEND}` }));
    const result = await exchangeGmailCode('c', 'v');
    expect(result.ok && result.grant.scopes).toEqual([GMAIL_SEND, USERINFO_EMAIL, 'openid']);
  });

  it('refuses scope_missing when gmail.send was not granted, carrying no token', async () => {
    configure();
    stubFetch(() => grantResponse({ scope: `openid ${USERINFO_EMAIL}` }));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'scope_missing' });
  });

  it('refuses scope_unexpected when Google granted more than was asked', async () => {
    configure();
    stubFetch(() => grantResponse({ scope: `openid email ${GMAIL_SEND} https://www.googleapis.com/auth/gmail.readonly` }));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'scope_unexpected' });
  });

  it.each([
    ['another audience', { aud: 'someone-else' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 10 }],
    ['no sub', { sub: undefined }],
    ['no email', { email: undefined }],
  ])('fails on an id_token with %s, ', async (_label, overrides) => {
    configure();
    stubFetch(() => grantResponse({ id_token: idToken(overrides) }));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'failed' });
  });

  it('fails without an id_token, or with one that is not a JWT', async () => {
    configure();
    stubFetch(() => grantResponse({ id_token: undefined }));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'failed' });
    stubFetch(() => grantResponse({ id_token: 'not-a-jwt' }));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'failed' });
  });

  it('refuses not_workspace for a consumer account (no hd claim)', async () => {
    configure();
    stubFetch(() => grantResponse({ id_token: idToken({ hd: undefined, email: 'storm@gmail.com' }) }));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'not_workspace' });
  });

  it('fails on an error response, no response, or no refresh token', async () => {
    configure();
    stubFetch(() => json({ error: 'invalid_grant', error_description: CANARY }, 400));
    const refused = await exchangeGmailCode('c', 'v');
    expect(refused).toEqual({ ok: false, reason: 'failed' });
    expect(JSON.stringify(refused)).not.toContain('CANARY');
    stubFetch(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'failed' });
    stubFetch(() => grantResponse({ refresh_token: undefined }));
    expect(await exchangeGmailCode('c', 'v')).toEqual({ ok: false, reason: 'failed' });
  });

  it('reads email_verified as a boolean or the string "true" only', async () => {
    configure();
    const verified = async (value: unknown) => {
      stubFetch(() => grantResponse({ id_token: idToken({ email_verified: value }) }));
      const result = await exchangeGmailCode('c', 'v');
      return result.ok ? result.grant.emailVerified : null;
    };
    expect(await verified(true)).toBe(true);
    expect(await verified('true')).toBe(true);
    expect(await verified(false)).toBe(false);
    expect(await verified('yes')).toBe(false);
    expect(await verified(undefined)).toBe(false);
  });
});

describe('checkGrantIdentity', () => {
  const grant = (overrides: Partial<GmailGrant> = {}): GmailGrant => ({
    refreshToken: 'rt-1',
    email: 'storm@ignatious.com',
    emailVerified: true,
    sub: 'google-sub-1',
    hd: 'ignatious.com',
    scopes: ['email', GMAIL_SEND, 'openid'],
    ...overrides,
  });
  const who = { email: 'Storm@Ignatious.com', firmDomains: ['Ignatious.com'] };

  it('accepts the banker\'s own verified Workspace account, case-insensitively', () => {
    expect(checkGrantIdentity(grant(), who)).toBeNull();
    expect(checkGrantIdentity(grant(), { ...who, boundSub: 'google-sub-1' })).toBeNull();
  });

  it('refuses wrong_account for an unverified email, another email, or a sub that is not the bound one', () => {
    expect(checkGrantIdentity(grant({ emailVerified: false }), who)).toBe('wrong_account');
    expect(checkGrantIdentity(grant({ email: 'colleague@ignatious.com' }), who)).toBe('wrong_account');
    expect(checkGrantIdentity(grant(), { ...who, boundSub: 'google-sub-2' })).toBe('wrong_account');
  });

  it('refuses not_workspace for a domain that is not the firm\'s, no hd, or no firm domain', () => {
    expect(checkGrantIdentity(grant({ hd: 'other.example' }), who)).toBe('not_workspace');
    expect(checkGrantIdentity(grant({ hd: null }), who)).toBe('not_workspace');
    expect(checkGrantIdentity(grant(), { ...who, firmDomains: [] })).toBe('not_workspace');
  });
});

describe('refresh classification', () => {
  it('returns a fresh access token', async () => {
    configure();
    const fetchMock = stubFetch(() => json({ access_token: 'at-2', expires_in: 3599 }));
    expect(await refreshGmailAccessToken('rt-1')).toEqual({ ok: true, accessToken: 'at-2' });
    const form = formOf(fetchMock.mock.calls[0][1]!);
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('rt-1');
  });

  it.each([
    ['plain invalid_grant', { error: 'invalid_grant', error_description: CANARY }],
    ['invalid_grant with a subtype', { error: 'invalid_grant', error_subtype: 'invalid_rapt', error_description: CANARY }],
  ])('marks %s as revoked', async (_label, body) => {
    configure();
    stubFetch(() => json(body, 400));
    const result = await refreshGmailAccessToken('rt-1');
    expect(result).toEqual({ ok: false, kind: 'revoked', status: 400 });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('treats a refused client as misconfigured, never as a revoked banker', async () => {
    configure();
    stubFetch(() => json({ error: 'invalid_client', error_description: CANARY }, 401));
    expect(await refreshGmailAccessToken('rt-1')).toEqual({ ok: false, kind: 'misconfigured', status: 401 });
    stubFetch(() => json({ error: 'unauthorized_client' }, 400));
    expect(await refreshGmailAccessToken('rt-1')).toEqual({ ok: false, kind: 'misconfigured', status: 400 });
  });

  it('leaves 5xx, other 400s, a timeout and a token-less 200 as upstream', async () => {
    configure();
    stubFetch(() => json({ error: 'backend_error' }, 503));
    expect(await refreshGmailAccessToken('rt-1')).toEqual({ ok: false, kind: 'upstream', status: 503 });
    stubFetch(() => json({ error: 'invalid_request' }, 400));
    expect(await refreshGmailAccessToken('rt-1')).toEqual({ ok: false, kind: 'upstream', status: 400 });
    stubFetch(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    expect(await refreshGmailAccessToken('rt-1')).toEqual({ ok: false, kind: 'upstream', status: 0 });
    stubFetch(() => json({}));
    expect(await refreshGmailAccessToken('rt-1')).toEqual({ ok: false, kind: 'upstream', status: 200 });
  });
});

describe('messages.send', () => {
  it('posts {raw} with the bearer token and returns Gmail\'s ids', async () => {
    const fetchMock = stubFetch(() => json({ id: 'msg-1', threadId: 'thr-1', labelIds: ['SENT'] }));
    expect(await gmailSendRaw('at-1', 'cmF3')).toEqual({ id: 'msg-1', threadId: 'thr-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SEND_URL);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
    expect(JSON.parse(String(init!.body))).toEqual({ raw: 'cmF3' });
  });

  it('throws on a 5xx after exactly one call, with the reason code and no body', async () => {
    const fetchMock = stubFetch(() =>
      json({ error: { code: 500, message: CANARY, status: 'INTERNAL', errors: [{ reason: 'backendError', message: CANARY }] } }, 500),
    );
    const failure = await gmailSendRaw('at-1', 'cmF3').catch((err: unknown) => err);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(UpstreamHttpError);
    expect(failure).toMatchObject({ provider: 'gmail-send', op: 'messages.send', status: 500, code: 'backendError' });
    expect(String((failure as Error).message)).not.toContain('CANARY');
  });

  it('keeps a 403 policy reason, and reports no response as status 0', async () => {
    stubFetch(() => json({ error: { code: 403, message: CANARY, errors: [{ reason: 'domainPolicy' }] } }, 403));
    await expect(gmailSendRaw('at-1', 'cmF3')).rejects.toMatchObject({ status: 403, code: 'domainPolicy' });
    const fetchMock = stubFetch(() => Promise.reject(new TypeError(`fetch failed ${CANARY}`)));
    const failure = await gmailSendRaw('at-1', 'cmF3').catch((err: unknown) => err);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failure).toMatchObject({ provider: 'gmail-send', status: 0 });
    expect(String((failure as Error).message)).not.toContain('CANARY');
  });

  it('throws when a 2xx carries no message id', async () => {
    stubFetch(() => json({}));
    await expect(gmailSendRaw('at-1', 'cmF3')).rejects.toMatchObject({ provider: 'gmail-send', code: 'no_message_id' });
  });
});
