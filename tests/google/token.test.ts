// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GMAIL_READER_SCOPE } from '@/lib/constants/googleReader';
import { GOOGLE_HTTP_DEFAULTS } from '@/lib/google/reader/http';
import {
  GOOGLE_TOKEN_TIMEOUT_MS,
  GoogleTokenError,
  createDelegatedTokenCache,
  serviceAccountAccessToken,
} from '@/lib/google/reader/token';

import { scripted, type Reply } from './helpers';

const IDENTITY = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  serviceAccountEmail: 'dwd-reader@proj-1.iam.gserviceaccount.com',
};
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

const sign = (signedJwt = 'signed.jwt.value'): Reply => ({ status: 200, body: { signedJwt } });
const token = (access = 'ya29.mailbox', expires_in = 3600): Reply => ({ status: 200, body: { access_token: access, expires_in } });

function setup(replies: Reply[], clock = { now: NOW }) {
  const { fetchImpl, calls } = scripted(replies);
  const outcomes: string[] = [];
  const cache = createDelegatedTokenCache({
    callerToken: async () => 'caller-token',
    fetchImpl,
    now: () => clock.now,
    onOutcome: (_i, outcome) => outcomes.push(outcome),
  });
  return { cache, calls, outcomes, clock };
}

describe('createDelegatedTokenCache', () => {
  it('signs a delegation JWT with the expected claims, through IAM Credentials with the caller token', async () => {
    const { cache, calls } = setup([sign(), token()]);
    const result = await cache.forSubject(IDENTITY, 'Storm.Duncan@Bank.Example', GMAIL_READER_SCOPE.READONLY)();
    expect(result).toBe('ya29.mailbox');

    const signCall = calls[0];
    expect(new URL(signCall.url).origin).toBe('https://iamcredentials.googleapis.com');
    expect(signCall.url).toContain(':signJwt');
    expect(signCall.url).toContain(encodeURIComponent(IDENTITY.serviceAccountEmail));
    expect(new Headers(signCall.init.headers).get('Authorization')).toBe('Bearer caller-token');
    const payload = JSON.parse(JSON.parse(String(signCall.init.body)).payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      iss: IDENTITY.serviceAccountEmail,
      sub: 'storm.duncan@bank.example',
      scope: GMAIL_READER_SCOPE.READONLY,
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it('exchanges the signed JWT at the token endpoint with the jwt-bearer grant', async () => {
    const { cache, calls } = setup([sign('abc.def.ghi'), token()]);
    await cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)();
    const exchange = calls[1];
    expect(exchange.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(exchange.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')).toBe('abc.def.ghi');
  });

  it('serves a cache hit within the margin and refreshes inside it', async () => {
    const { cache, calls, clock } = setup([sign(), token('t1', 3600), sign(), token('t2', 3600)]);
    const get = cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY);
    expect(await get()).toBe('t1');
    clock.now += 50 * 60_000; // 10 minutes left, outside the 5 minute margin
    expect(await get()).toBe('t1');
    expect(calls).toHaveLength(2);
    clock.now += 6 * 60_000; // 4 minutes left, inside the margin
    expect(await get()).toBe('t2');
    expect(calls).toHaveLength(4);
  });

  it('forceRefresh bypasses the cache', async () => {
    const { cache, calls } = setup([sign(), token('t1'), sign(), token('t2')]);
    const get = cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY);
    expect(await get()).toBe('t1');
    expect(await get({ forceRefresh: true })).toBe('t2');
    expect(calls).toHaveLength(4);
  });

  it('never shares a token between scopes', async () => {
    const { cache, calls } = setup([sign(), token('readonly-token'), sign(), token('metadata-token')]);
    const wide = cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY);
    const narrow = cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.METADATA);
    expect(await wide()).toBe('readonly-token');
    expect(await narrow()).toBe('metadata-token');
    expect(calls).toHaveLength(4);
    const scopes = [calls[0], calls[2]].map(
      (c) => (JSON.parse(JSON.parse(String(c.init.body)).payload) as { scope: string }).scope,
    );
    expect(scopes).toEqual([GMAIL_READER_SCOPE.READONLY, GMAIL_READER_SCOPE.METADATA]);
  });

  it('turns unauthorized_client into a GoogleTokenError and a missing-delegation outcome', async () => {
    const { cache, outcomes } = setup([sign(), { status: 401, body: { error: 'unauthorized_client' } }]);
    const error = await cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleTokenError);
    expect(error).toMatchObject({ reason: 'unauthorized_client', status: 401 });
    expect(outcomes).toEqual(['missing']);
  });

  it('drops a token endpoint error that is not code-shaped from the thrown message (#331)', async () => {
    const CANARY = 'Quarterly Board Memo for Project Falcon';
    const { cache, outcomes } = setup([sign(), { status: 400, body: { error: CANARY } }]);
    const error = (await cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch((e: unknown) => e)) as GoogleTokenError;
    expect(error).toBeInstanceOf(GoogleTokenError);
    expect(error).toMatchObject({ reason: null, status: 400 });
    expect(error.message).toBe('Google token exchange failed: 400');
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('Falcon');
    expect(outcomes).toEqual(['error']);
  });

  it('reports other token endpoint failures as error, and success as ok', async () => {
    const failing = setup([sign(), { status: 400, body: { error: 'invalid_grant' } }]);
    await failing.cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch(() => undefined);
    expect(failing.outcomes).toEqual(['error']);

    const working = setup([sign(), token()]);
    await working.cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)();
    expect(working.outcomes).toEqual(['ok']);
  });

  it('reports a refused signJwt as error, before any token exchange', async () => {
    const { cache, calls, outcomes } = setup([{ status: 403, body: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'forbidden' }] } } }]);
    const error = await cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'GoogleHttpError', status: 403 });
    expect(outcomes).toEqual(['error']);
    expect(calls).toHaveLength(1);
  });

  it('never holds key material in a request body or a thrown message', async () => {
    const { cache, calls } = setup([sign(), { status: 400, body: { error: 'invalid_grant' } }]);
    const error = (await cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch((e: unknown) => e)) as Error;
    const everything = JSON.stringify(calls.map((c) => [c.url, String(c.init.body)])) + error.message;
    expect(everything).not.toMatch(/private_key/i);
    expect(everything).not.toContain('-----' + 'BEGIN');
  });
});

describe('serviceAccountAccessToken', () => {
  it("asks IAM Credentials for the service account's own token, with no subject", async () => {
    const { fetchImpl, calls } = scripted([{ status: 200, body: { accessToken: 'directory-token' } }]);
    const result = await serviceAccountAccessToken(
      async () => 'caller-token',
      'dir-reader@proj-1.iam.gserviceaccount.com',
      ['https://www.googleapis.com/auth/admin.directory.group.member.readonly'],
      fetchImpl,
    );
    expect(result).toBe('directory-token');
    expect(calls[0].url).toContain(':generateAccessToken');
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      scope: ['https://www.googleapis.com/auth/admin.directory.group.member.readonly'],
      lifetime: '3600s',
    });
    expect(body).not.toHaveProperty('sub');
  });
});

// Fakes that honour the request's signal, as fetch does.
const hanging: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
const stalledBodyWith =
  (status: number): typeof fetch =>
  async (_url, init) =>
    new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)); } }), { status });
const stalledBody = stalledBodyWith(200);

describe('the token exchange deadline', () => {
  // The signJwt call goes through the same fetch; only the exchange (TOKEN_URL) is made to stall.
  function stalling(exchange: typeof fetch) {
    const { fetchImpl } = scripted([sign()]);
    const outcomes: string[] = [];
    const routed: typeof fetch = (url, init) => (String(url) === 'https://oauth2.googleapis.com/token' ? exchange(url, init) : fetchImpl(url, init));
    const cache = createDelegatedTokenCache({
      callerToken: async () => 'caller-token',
      fetchImpl: routed,
      now: () => NOW,
      timeoutMs: 20,
      onOutcome: (_i, outcome) => outcomes.push(outcome),
    });
    return { cache, outcomes };
  }
  const mintFrom = (cache: ReturnType<typeof stalling>['cache']) =>
    cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch((e: unknown) => e);

  it('times out a hung exchange and records no delegation outcome', async () => {
    const { cache, outcomes } = stalling(hanging);
    expect(await mintFrom(cache)).toMatchObject({ name: 'TimeoutError' });
    expect(outcomes).toEqual([]);
  });

  it('times out a stalled exchange body and records no delegation outcome', async () => {
    const { cache, outcomes } = stalling(stalledBody);
    expect(await mintFrom(cache)).toMatchObject({ name: 'TimeoutError' });
    expect(outcomes).toEqual([]);
  });

  it('times out a stalled 403 exchange body: no refusal, no outcome', async () => {
    const { cache, outcomes } = stalling(stalledBodyWith(403));
    const error = await mintFrom(cache);
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(error).not.toBeInstanceOf(GoogleTokenError);
    expect(outcomes).toEqual([]);
  });

  it('a stalled 403 signJwt body is a timeout: no outcome', async () => {
    // signJwt runs on googleFetch's 60 s default; this body fails as fetch fails it when that deadline fires.
    const timedOutBody: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            setTimeout(() => c.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 5);
          },
        }),
        { status: 403 },
      );
    const outcomes: string[] = [];
    const cache = createDelegatedTokenCache({
      callerToken: async () => 'caller-token',
      fetchImpl: timedOutBody,
      onOutcome: (_i, outcome) => outcomes.push(outcome),
    });
    expect(await mintFrom(cache)).toMatchObject({ name: 'TimeoutError' });
    expect(outcomes).toEqual([]);
  });

  it('a 403 exchange whose body is not JSON is still a refusal with an outcome', async () => {
    const outcomes: string[] = [];
    const { fetchImpl } = scripted([sign()]);
    const routed: typeof fetch = (url, init) =>
      String(url) === 'https://oauth2.googleapis.com/token' ? Promise.resolve(new Response('denied', { status: 403 })) : fetchImpl(url, init);
    const cache = createDelegatedTokenCache({ callerToken: async () => 'caller-token', fetchImpl: routed, onOutcome: (_i, o) => outcomes.push(o) });
    expect(await mintFrom(cache)).toMatchObject({ name: 'GoogleTokenError', status: 403, reason: null });
    expect(outcomes).toEqual(['error']);
  });

  it('rethrows a signJwt timeout without an outcome, and still records a refused signJwt', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const timedOut: string[] = [];
    const a = createDelegatedTokenCache({
      callerToken: async () => 'caller-token',
      fetchImpl: () => Promise.reject(timeout),
      onOutcome: (_i, outcome) => timedOut.push(outcome),
    });
    expect(await a.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch((e: unknown) => e)).toBe(timeout);
    expect(timedOut).toEqual([]);

    const { cache, outcomes } = setup([{ status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } }]);
    await cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)().catch(() => undefined);
    expect(outcomes).toEqual(['error']);
  });
});

describe('the token-side deadline defaults', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the exchange gets 15 s and signJwt googleFetch\'s 60 s when no timeoutMs is given', async () => {
    expect(GOOGLE_TOKEN_TIMEOUT_MS).toBe(15_000);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { cache, calls } = setup([sign(), token()]);
    await cache.forSubject(IDENTITY, 'a@bank.example', GMAIL_READER_SCOPE.READONLY)();
    expect(timeout.mock.calls).toEqual([[GOOGLE_HTTP_DEFAULTS.timeoutMs], [15_000]]);
    expect(calls[1].init.signal).toBe(timeout.mock.results[1].value);
  });
});
