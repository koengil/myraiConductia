// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  backoffMs,
  graphDownload,
  GraphDownloadTooLargeError,
  graphFetch,
  GraphHttpError,
  graphJson,
  graphPages,
  graphUrl,
  isDeadlineError,
  retryAfterMs,
  type GraphHttpOptions,
} from '@/lib/graph/http';
import { captureConsole } from '../helpers/consoleCapture';

/*
 * The shared Graph client over a stubbed fetch (as tests/email-graph.test.ts
 * does): throttling, backoff, token refresh, paging and downloads. No request
 * leaves the process.
 */

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function scripted(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected request ${String(url)}`);
    if (reply instanceof Error) throw reply;
    const body = reply.body === undefined ? null : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status, headers: reply.headers });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function options(fetchImpl: typeof fetch, extra: Partial<GraphHttpOptions> = {}) {
  const sleeps: number[] = [];
  const getToken = vi.fn(async (o?: { forceRefresh?: boolean }) => (o?.forceRefresh ? 'token-2' : 'token-1'));
  const opts: GraphHttpOptions = {
    getToken,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  };
  return { opts, sleeps, getToken };
}

// Graph's request ids are GUIDs; a well-formed one passes through, anything else is dropped (#331).
const GUID = 'a1b2c3d4-0000-4000-8000-000000000009';

const authOf = (init: RequestInit) => new Headers(init.headers).get('Authorization');

describe('graphFetch', () => {
  it('waits out a 429 for the Retry-After seconds, then succeeds', async () => {
    const { fetchImpl, calls } = scripted([
      { status: 429, headers: { 'Retry-After': '7' } },
      { status: 200, body: { ok: true } },
    ]);
    const { opts, sleeps } = options(fetchImpl);
    const res = await graphFetch('/users/a%40b.example/messages', {}, opts);
    expect(await res.json()).toEqual({ ok: true });
    expect(sleeps).toEqual([7000]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/users/a%40b.example/messages');
    expect(authOf(calls[1].init)).toBe('Bearer token-1');
  });

  it('reads Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-09-25T10:00:00Z');
    expect(retryAfterMs('Fri, 25 Sep 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('nonsense', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });

  it('backs off exponentially with jitter on a 5xx without Retry-After', async () => {
    const { fetchImpl } = scripted([{ status: 503 }, { status: 502 }, { status: 200, body: {} }]);
    const { opts, sleeps } = options(fetchImpl, { baseDelayMs: 1000, maxDelayMs: 60_000 });
    await graphFetch('/x', {}, opts);
    // attempt 1 -> ceiling 2000, attempt 2 -> 4000; random 0.5 takes half.
    expect(sleeps).toEqual([1000, 2000]);
    expect(backoffMs(10, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0.99 })).toBe(59_400);
  });

  it('gives up after maxAttempts with the status and code, never the body', async () => {
    const replies: Reply[] = Array.from({ length: 3 }, () => ({
      status: 429,
      headers: { 'Retry-After': '1', 'request-id': GUID },
      body: { error: { code: 'ApplicationThrottled', message: 'Subject: Project Falcon' } },
    }));
    const { fetchImpl } = scripted(replies);
    const { opts } = options(fetchImpl, { maxAttempts: 3 });
    const error = await graphFetch('/x', {}, opts).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphHttpError);
    expect(error).toMatchObject({ status: 429, code: 'ApplicationThrottled', requestId: GUID, throttled: true });
    expect((error as Error).message).not.toContain('Falcon');
  });

  it('keeps only a code-shaped error code and a GUID request id (CANARY-331 in either never surfaces)', async () => {
    const capture = captureConsole();
    try {
      const { fetchImpl } = scripted([
        {
          status: 403,
          headers: { 'request-id': 'CANARY-331 quoted subject line' },
          body: { error: { code: 'CANARY-331 quoted subject line', message: 'Subject: Project Falcon' } },
        },
      ]);
      const { opts } = options(fetchImpl);
      const error = (await graphFetch('/x', {}, opts).catch((e: unknown) => e)) as GraphHttpError;
      expect(error).toBeInstanceOf(GraphHttpError);
      expect(error.status).toBe(403);
      expect(error.code).toBeNull();
      expect(error.requestId).toBeNull();
      expect(error.message).not.toContain('CANARY-331');
      expect(String(error.stack)).not.toContain('CANARY-331');
      expect(capture.output()).not.toContain('CANARY-331');
    } finally {
      capture.restore();
    }
  });

  it('keeps a well-formed Graph error code and GUID request id (the Graph <status> <code> label depends on them)', async () => {
    const { fetchImpl } = scripted([
      { status: 404, headers: { 'request-id': GUID }, body: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found' } } },
    ]);
    const { opts } = options(fetchImpl);
    const error = (await graphFetch('/x', {}, opts).catch((e: unknown) => e)) as GraphHttpError;
    expect(error).toMatchObject({ status: 404, code: 'ErrorItemNotFound', requestId: GUID });
    expect(error.message).toBe(`Graph request failed: 404 ErrorItemNotFound (request-id ${GUID})`);
  });

  it('does not retry a 403 (a mailbox outside the RBAC scope)', async () => {
    const { fetchImpl, calls } = scripted([{ status: 403, body: { error: { code: 'ErrorAccessDenied' } } }]);
    const { opts } = options(fetchImpl);
    await expect(graphFetch('/users/out%40bank.example/messages', {}, opts)).rejects.toMatchObject({
      status: 403,
      code: 'ErrorAccessDenied',
    });
    expect(calls).toHaveLength(1);
  });

  it('refreshes the token once on a 401', async () => {
    const { fetchImpl, calls } = scripted([{ status: 401 }, { status: 200, body: {} }]);
    const { opts, getToken } = options(fetchImpl);
    await graphFetch('/x', {}, opts);
    expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(authOf(calls[1].init)).toBe('Bearer token-2');
  });

  it('retries a network failure', async () => {
    const { fetchImpl } = scripted([new TypeError('fetch failed'), { status: 200, body: {} }]);
    const { opts, sleeps } = options(fetchImpl);
    await graphFetch('/x', {}, opts);
    expect(sleeps).toHaveLength(1);
  });

  it('never sends the token to another host', () => {
    expect(() => graphUrl('https://evil.example/v1.0/users')).toThrow('Refusing to send a Graph token');
    expect(graphUrl('https://graph.microsoft.com/v1.0/users?$skiptoken=a')).toBe(
      'https://graph.microsoft.com/v1.0/users?$skiptoken=a',
    );
  });

  it('adds default headers without overriding a caller header', async () => {
    const { fetchImpl, calls } = scripted([{ status: 200, body: {} }]);
    const { opts } = options(fetchImpl, { headers: { Prefer: 'odata.maxpagesize=50' } });
    await graphJson('/x', opts);
    expect(new Headers(calls[0].init.headers).get('Prefer')).toBe('odata.maxpagesize=50');
  });
});

describe('graphPages', () => {
  it('follows @odata.nextLink and reports the link that resumes after each page', async () => {
    const next = 'https://graph.microsoft.com/v1.0/users/a/messages/delta?$skiptoken=p2';
    const delta = 'https://graph.microsoft.com/v1.0/users/a/messages/delta?$deltatoken=d1';
    const { fetchImpl, calls } = scripted([
      { status: 200, body: { value: [{ id: '1' }, { id: '2' }], '@odata.nextLink': next } },
      { status: 200, body: { value: [{ id: '3' }], '@odata.deltaLink': delta } },
    ]);
    const { opts } = options(fetchImpl);
    const pages = [];
    for await (const page of graphPages<{ id: string }>('/users/a/messages/delta', opts)) pages.push(page);
    expect(pages).toEqual([
      { value: [{ id: '1' }, { id: '2' }], nextLink: next, deltaLink: null },
      { value: [{ id: '3' }], nextLink: null, deltaLink: delta },
    ]);
    expect(calls.map((c) => c.url)).toEqual(['https://graph.microsoft.com/v1.0/users/a/messages/delta', next]);
  });

  it('refuses a nextLink that leaves Graph', async () => {
    const { fetchImpl } = scripted([
      { status: 200, body: { value: [], '@odata.nextLink': 'https://evil.example/next' } },
    ]);
    const { opts } = options(fetchImpl);
    const read = async () => {
      for await (const page of graphPages('/x', opts)) void page;
    };
    await expect(read()).rejects.toThrow('Refusing to send a Graph token to https://evil.example');
  });
});

describe('graphDownload', () => {
  it('follows the pre-authenticated redirect without the bearer token', async () => {
    const { fetchImpl, calls } = scripted([
      { status: 302, headers: { Location: 'https://tenant.sharepoint.com/download?tempauth=x' } },
      { status: 200, body: 'file bytes' },
    ]);
    const { opts } = options(fetchImpl);
    const bytes = await graphDownload('/drives/d/items/i/content', { ...opts, maxBytes: 1024 });
    expect(Buffer.from(bytes).toString()).toBe('file bytes');
    expect(calls[0].init.redirect).toBe('manual');
    expect(authOf(calls[0].init)).toBe('Bearer token-1');
    expect(calls[1].url).toBe('https://tenant.sharepoint.com/download?tempauth=x');
    expect(authOf(calls[1].init)).toBeNull();
  });

  it('stops reading past the byte cap', async () => {
    const { fetchImpl } = scripted([
      { status: 302, headers: { Location: 'https://tenant.sharepoint.com/f' } },
      { status: 200, body: 'x'.repeat(2048) },
    ]);
    const { opts } = options(fetchImpl);
    await expect(graphDownload('/drives/d/items/i/content', { ...opts, maxBytes: 1024 })).rejects.toBeInstanceOf(
      GraphDownloadTooLargeError,
    );
  });

  it('refuses a redirect that is not https', async () => {
    const { fetchImpl } = scripted([{ status: 302, headers: { Location: 'http://tenant.sharepoint.com/f' } }]);
    const { opts } = options(fetchImpl);
    await expect(graphDownload('/drives/d/items/i/content', { ...opts, maxBytes: 1024 })).rejects.toThrow(
      'not an https URL',
    );
  });
});

// Fakes that honour the request's signal, as fetch does.
const hanging: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) return reject(init.signal.reason);
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });
const stalledBodyWith =
  (status: number): typeof fetch =>
  async (_url, init) =>
    new Response(new ReadableStream({ start(c) { init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason)); } }), { status });

describe('the Graph request deadline (#409 F4)', () => {
  it('rejects a hung request with a TimeoutError after one call, with no retry', async () => {
    let calls = 0;
    const counted: typeof fetch = (url, init) => {
      calls += 1;
      return hanging(url, init);
    };
    const { opts, sleeps } = options(counted, { timeoutMs: 20 });
    const error = await graphFetch('/x', {}, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(isDeadlineError(error)).toBe(true);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('keeps the deadline on the response body', async () => {
    const { opts } = options(stalledBodyWith(200), { timeoutMs: 20 });
    const error = await graphJson('/x', opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
  });

  it('a stalled error body is a timeout, not a GraphHttpError', async () => {
    const { opts, sleeps } = options(stalledBodyWith(404), { timeoutMs: 20 });
    const error = await graphFetch('/x', {}, opts).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(error).not.toBeInstanceOf(GraphHttpError);
    expect(sleeps).toEqual([]);
  });

  it('bounds the download redirect too', async () => {
    const fetchImpl: typeof fetch = async (url, init) =>
      String(url).startsWith('https://graph.microsoft.com')
        ? new Response(null, { status: 302, headers: { Location: 'https://tenant.sharepoint.com/f' } })
        : hanging(url, init);
    const { opts } = options(fetchImpl, { timeoutMs: 20 });
    const error = await graphDownload('/drives/d/items/i/content', { ...opts, maxBytes: 1024 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
  });

  it('bounds a download body that stalls after the headers', async () => {
    const stalled = stalledBodyWith(200);
    const fetchImpl: typeof fetch = async (url, init) =>
      String(url).startsWith('https://graph.microsoft.com')
        ? new Response(null, { status: 302, headers: { Location: 'https://tenant.sharepoint.com/f' } })
        : stalled(url, init);
    const { opts } = options(fetchImpl, { timeoutMs: 20 });
    const error = await graphDownload('/drives/d/items/i/content', { ...opts, maxBytes: 1024 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'TimeoutError' });
  });

  it("keeps a caller's own signal: an aborted caller ends the request with no retry", async () => {
    let calls = 0;
    const counted: typeof fetch = (url, init) => {
      calls += 1;
      return hanging(url, init);
    };
    const { opts, sleeps } = options(counted);
    const caller = new AbortController();
    const pending = graphFetch('/x', { signal: caller.signal }, opts).catch((e: unknown) => e);
    caller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('sends a signal on every attempt', async () => {
    const { fetchImpl, calls } = scripted([{ status: 200, body: {} }]);
    const { opts } = options(fetchImpl);
    await graphFetch('/x', {}, opts);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });
});
