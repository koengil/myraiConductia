// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_HTTP_DEFAULTS, GoogleHttpError, googleFetch, googleJson, googleUrl } from '@/lib/google/reader/http';

import { options, scripted, type Reply } from './helpers';

const PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

describe('googleFetch', () => {
  it('retries a 429 after its Retry-After, then succeeds', async () => {
    const { fetchImpl, calls } = scripted([
      { status: 429, headers: { 'Retry-After': '3' }, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
      { status: 200, body: { emailAddress: 'a@b.example' } },
    ]);
    const { opts, sleeps } = options(fetchImpl);
    const res = await googleFetch(PROFILE, {}, opts);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('retries a 403 userRateLimitExceeded and marks the final error throttled', async () => {
    const reply: Reply = { status: 403, body: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } };
    const { fetchImpl, calls } = scripted([reply, reply, reply]);
    const { opts, sleeps } = options(fetchImpl, { maxAttempts: 3 });
    const error = await googleFetch(PROFILE, {}, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleHttpError);
    expect(error).toMatchObject({ status: 403, reason: 'userRateLimitExceeded', throttled: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry a 403 forbidden', async () => {
    const { fetchImpl, calls } = scripted([{ status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } }]);
    const { opts } = options(fetchImpl);
    const error = await googleFetch(PROFILE, {}, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 403, reason: 'forbidden', throttled: false });
    expect(calls).toHaveLength(1);
  });

  it('retries a 5xx with full-jitter backoff', async () => {
    const { fetchImpl } = scripted([{ status: 503 }, { status: 200, body: {} }]);
    const { opts, sleeps } = options(fetchImpl, { baseDelayMs: 1000 });
    await googleFetch(PROFILE, {}, opts);
    expect(sleeps).toEqual([500]);
  });

  it('forces one token refresh on a 401, then gives up on a second 401', async () => {
    const ok = scripted([{ status: 401 }, { status: 200, body: {} }]);
    const first = options(ok.fetchImpl);
    await googleFetch(PROFILE, {}, first.opts);
    expect(first.tokenCalls).toEqual([undefined, { forceRefresh: true }]);
    expect(ok.calls.map((c) => new Headers(c.init.headers).get('Authorization'))).toEqual(['Bearer token-1', 'Bearer token-2']);

    const bad = scripted([{ status: 401 }, { status: 401 }]);
    const second = options(bad.fetchImpl);
    await expect(googleFetch(PROFILE, {}, second.opts)).rejects.toMatchObject({ status: 401 });
    expect(bad.calls).toHaveLength(2);
  });

  it('sets the bearer last, so a caller cannot override it', async () => {
    const { fetchImpl, calls } = scripted([{ status: 200, body: {} }]);
    const { opts } = options(fetchImpl);
    await googleFetch(PROFILE, { headers: { Authorization: 'Bearer attacker', 'X-Test': '1' } }, opts);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    expect(headers.get('X-Test')).toBe('1');
  });

  it('refuses a foreign origin before any fetch or token request', async () => {
    const { fetchImpl, calls } = scripted([]);
    const { opts, tokenCalls } = options(fetchImpl);
    await expect(googleFetch('https://evil.example/gmail/v1/users/me/profile', {}, opts)).rejects.toThrow(
      'Refusing to send a Google token to https://evil.example',
    );
    expect(calls).toHaveLength(0);
    expect(tokenCalls).toHaveLength(0);
    expect(() => googleUrl('http://gmail.googleapis.com/x')).toThrow();
  });

  it('reads the OAuth token endpoint error code as the reason', async () => {
    const { fetchImpl } = scripted([{ status: 400, body: { error: 'unauthorized_client', error_description: 'secret words' } }]);
    const { opts } = options(fetchImpl);
    const error = (await googleFetch('https://oauth2.googleapis.com/token', {}, opts).catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ status: 400, reason: 'unauthorized_client' });
    expect(error.message).not.toContain('secret words');
  });

  it('never puts a response body in the error', async () => {
    const replies: Reply[] = Array.from({ length: 3 }, () => ({
      status: 429,
      headers: { 'Retry-After': '1' },
      body: { error: { code: 429, message: 'Subject: Project Falcon', errors: [{ reason: 'rateLimitExceeded' }] } },
    }));
    const { fetchImpl } = scripted(replies);
    const error = await googleFetch(PROFILE, {}, options(fetchImpl, { maxAttempts: 3 }).opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 429, reason: 'rateLimitExceeded', throttled: true });
    expect((error as Error).message).not.toContain('Falcon');
  });

  it.each([
    ['errors[0].reason', { error: { errors: [{ reason: 'Quarterly Board Memo for Project Falcon' }] } }],
    ['error.status', { error: { status: 'Quarterly Board Memo for Project Falcon' } }],
    ['an OAuth error string', { error: 'Quarterly Board Memo for Project Falcon' }],
  ])('drops a reason in %s that is not code-shaped', async (_label, body) => {
    const { fetchImpl } = scripted([{ status: 403, body }]);
    const error = (await googleFetch(PROFILE, {}, options(fetchImpl).opts).catch((e: unknown) => e)) as GoogleHttpError;
    expect(error).toBeInstanceOf(GoogleHttpError);
    expect(error).toMatchObject({ status: 403, reason: null, throttled: false });
    expect(error.message).not.toContain('Falcon');
    expect(JSON.stringify({ ...error })).not.toContain('Falcon');
  });

  it('keeps a code-shaped reason', async () => {
    const { fetchImpl } = scripted([{ status: 403, body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } }]);
    const error = (await googleFetch(PROFILE, {}, options(fetchImpl, { maxAttempts: 1 }).opts).catch(
      (e: unknown) => e,
    )) as GoogleHttpError;
    expect(error).toMatchObject({ status: 403, reason: 'rateLimitExceeded', throttled: true });
    expect(error.message).toContain('rateLimitExceeded');
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

describe('the Google request deadline', () => {
  it('rejects a hung request with a TimeoutError after one call, with no retry', async () => {
    let calls = 0;
    const counted: typeof fetch = (url, init) => {
      calls += 1;
      return hanging(url, init);
    };
    const { opts, sleeps } = options(counted, { timeoutMs: 20 });
    const error = await googleFetch(PROFILE, {}, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('keeps the deadline on the response body', async () => {
    const { opts } = options(stalledBody, { timeoutMs: 20 });
    const error = await googleJson(PROFILE, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
  });

  it('a stalled error body is a timeout, not a retried HTTP failure', async () => {
    let calls = 0;
    const stalled503 = stalledBodyWith(503);
    const counted: typeof fetch = (url, init) => {
      calls += 1;
      return stalled503(url, init);
    };
    const { opts, sleeps } = options(counted, { timeoutMs: 20 });
    const error = await googleFetch(PROFILE, {}, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(error).not.toBeInstanceOf(GoogleHttpError);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('an error body that is not JSON still gives no reason', async () => {
    const { opts } = options(async () => new Response('<html>busy</html>', { status: 503 }), { maxAttempts: 1 });
    const error = (await googleFetch(PROFILE, {}, opts).catch((e: unknown) => e)) as GoogleHttpError;
    expect(error).toBeInstanceOf(GoogleHttpError);
    expect(error.status).toBe(503);
    expect(error.reason).toBeNull();
  });
});

describe('the Google request deadline default', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is 60 s per attempt, and reaches the request signal when no timeoutMs is given', async () => {
    expect(GOOGLE_HTTP_DEFAULTS.timeoutMs).toBe(60_000);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { fetchImpl, calls } = scripted([{ status: 200, body: {} }]);
    await googleFetch(PROFILE, {}, options(fetchImpl).opts);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(calls[0].init.signal).toBe(timeout.mock.results[0].value);
  });
});
