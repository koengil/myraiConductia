// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { observeAuditWrites } from '@/lib/supabase/observeAuditWrites';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

import { captureConsole, type ConsoleCapture } from './helpers/consoleCapture';

/**
 * #474 (design Q4): the admin client's fetch writes one audit_write_failed line for
 * every failed POST to /rest/v1/audit_log, and changes nothing the caller sees.
 */

const CANARY = 'CANARY-331 Project Falcon jane@bank.example';
const BASE = 'http://audit-observer.invalid';
const AUDIT_URL = `${BASE}/rest/v1/audit_log?columns=%22action%22`;
const POST: RequestInit = { method: 'POST', body: JSON.stringify({ action: 'deal.viewed' }) };

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pgError = (code: unknown, status: number) =>
  json({ code, message: CANARY, details: CANARY, hint: CANARY }, status);

let capture: ConsoleCapture;
beforeEach(() => {
  capture = captureConsole();
});
afterEach(() => {
  capture.restore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const errorLines = () => vi.mocked(console.error).mock.calls.map((args) => args.join(' '));

describe('observeAuditWrites (#474)', () => {
  it.each([
    [409, '23505'],
    [400, '23514'],
    [500, 'P0001'],
    [403, '42501'],
  ])('a %i POST to audit_log logs one line with its status and SQLSTATE %s', async (status, code) => {
    const response = pgError(code, status);
    const inner = vi.fn<typeof fetch>(async () => response);

    const res = await observeAuditWrites(inner)(AUDIT_URL, POST);

    expect(res).toBe(response);
    await expect(res.json()).resolves.toMatchObject({ code, message: CANARY });
    expect(errorLines()).toEqual([JSON.stringify({ evt: 'audit_write_failed', status, sqlstate: code })]);
    expect(capture.lines()).toHaveLength(1);
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('a code outside the closed set is written as invalid, and nothing from the body reaches the line', async () => {
    const inner = vi.fn<typeof fetch>(async () => pgError(CANARY, 500));

    await observeAuditWrites(inner)(AUDIT_URL, POST);

    expect(errorLines()).toEqual(['{"evt":"audit_write_failed","status":500,"sqlstate":"invalid"}']);
    expect(capture.output()).not.toContain('CANARY-331');
    expect(capture.output()).not.toContain('Falcon');
  });

  it.each([
    ['a plain-text body', () => new Response(`${CANARY} upstream connect error`, { status: 502 })],
    ['a JSON body without a code', () => json({ message: CANARY }, 503)],
    ['an empty body', () => new Response(null, { status: 500 })],
  ])('%s logs the status and no sqlstate', async (_label, make) => {
    const response = make();
    const inner = vi.fn<typeof fetch>(async () => response);

    const res = await observeAuditWrites(inner)(AUDIT_URL, POST);

    expect(res).toBe(response);
    expect(errorLines()).toEqual([JSON.stringify({ evt: 'audit_write_failed', status: response.status })]);
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('a rejected fetch logs status 0 and rethrows the same error', async () => {
    const boom = new TypeError(`fetch failed ${CANARY}`);
    const inner = vi.fn<typeof fetch>(async () => {
      throw boom;
    });

    await expect(observeAuditWrites(inner)(AUDIT_URL, POST)).rejects.toBe(boom);

    expect(errorLines()).toEqual(['{"evt":"audit_write_failed","status":0}']);
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('passes the arguments through untouched and returns the same Response, body still readable', async () => {
    const response = json([{ id: 1 }], 201);
    const inner = vi.fn<typeof fetch>(async () => response);
    const init: RequestInit = { ...POST, headers: { prefer: 'return=representation' } };

    const res = await observeAuditWrites(inner)(AUDIT_URL, init);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][0]).toBe(AUDIT_URL);
    expect(inner.mock.calls[0][1]).toBe(init);
    expect(res).toBe(response);
    await expect(res.json()).resolves.toEqual([{ id: 1 }]);
    expect(capture.lines()).toEqual([]);
  });

  it('reads the method and URL from a Request input', async () => {
    const request = new Request(AUDIT_URL, POST);
    const inner = vi.fn<typeof fetch>(async () => pgError('23503', 409));

    await observeAuditWrites(inner)(request);

    expect(inner.mock.calls[0][0]).toBe(request);
    expect(errorLines()).toEqual(['{"evt":"audit_write_failed","status":409,"sqlstate":"23503"}']);
  });

  // The observer may not throw or hold the caller: its own checks fail open, and the
  // error body is read for its code only within a time and size bound.
  it.each([
    ['a method that is not a string', AUDIT_URL, { ...POST, method: 42 } as unknown as RequestInit],
    [
      'an input whose url cannot be read',
      Object.defineProperty({}, 'url', { get: () => { throw new Error(CANARY); } }) as unknown as RequestInfo,
      POST,
    ],
  ])('%s passes through to the inner fetch without throwing', async (_label, input, init) => {
    const response = pgError('23505', 409);
    const inner = vi.fn<typeof fetch>(async () => response);

    await expect(observeAuditWrites(inner)(input, init)).resolves.toBe(response);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('an error body that never ends delays the caller only by a bounded read', async () => {
    const endless = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":"23505",'));
      },
    });
    const response = new Response(endless, { status: 500 });
    const inner = vi.fn<typeof fetch>(async () => response);

    const started = Date.now();
    await expect(observeAuditWrites(inner)(AUDIT_URL, POST)).resolves.toBe(response);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(errorLines()).toEqual(['{"evt":"audit_write_failed","status":500}']);
  }, 3000);

  it('an error body over the size bound is not parsed, and the caller still reads all of it', async () => {
    const big = { code: '23505', message: `${CANARY} ${'x'.repeat(64 * 1024)}` };
    const response = json(big, 500);
    const inner = vi.fn<typeof fetch>(async () => response);

    const res = await observeAuditWrites(inner)(AUDIT_URL, POST);

    expect(res).toBe(response);
    await expect(res.json()).resolves.toEqual(big);
    expect(errorLines()).toEqual(['{"evt":"audit_write_failed","status":500}']);
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it.each([
    ['a GET of audit_log', `${BASE}/rest/v1/audit_log?select=*`, { method: 'GET' }],
    ['a HEAD of audit_log', `${BASE}/rest/v1/audit_log`, { method: 'HEAD' }],
    ['a POST to another table', `${BASE}/rest/v1/deals`, POST],
    ['a POST to a table whose name only starts with audit_log', `${BASE}/rest/v1/audit_logs`, POST],
    ['an RPC call', `${BASE}/rest/v1/rpc/create_document_with_audit`, POST],
    ['an auth admin call', `${BASE}/auth/v1/admin/users`, POST],
  ])('%s writes no line, failed or rejected', async (_label, url, init) => {
    const response = pgError('23505', 500);
    const failed = vi.fn<typeof fetch>(async () => response);
    expect(await observeAuditWrites(failed)(url, init)).toBe(response);

    const boom = new TypeError('fetch failed');
    const rejected = vi.fn<typeof fetch>(async () => {
      throw boom;
    });
    await expect(observeAuditWrites(rejected)(url, init)).rejects.toBe(boom);

    expect(capture.lines()).toEqual([]);
  });
});

describe('createSupabaseAdminClient observes audit writes (#474)', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', BASE);
    vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_audit_observer_test');
  });

  it('a rejected audit row logs one line and the caller still reads the PostgREST error', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => pgError('23514', 400));
    vi.stubGlobal('fetch', fetchMock);

    const { error } = await createSupabaseAdminClient().from('audit_log').insert({ action: 'deal.viewed' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error?.code).toBe('23514');
    expect(errorLines()).toEqual(['{"evt":"audit_write_failed","status":400,"sqlstate":"23514"}']);
    expect(capture.output()).not.toContain('CANARY-331');
  });

  it('an unreachable database logs status 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const { error } = await createSupabaseAdminClient().from('audit_log').insert({ action: 'deal.viewed' });

    expect(error).not.toBeNull();
    expect(errorLines()).toEqual(['{"evt":"audit_write_failed","status":0}']);
  });

  it('a failed write to another table logs nothing', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => pgError('23505', 409)));

    const { error } = await createSupabaseAdminClient().from('deals').insert({ code: 'PRJRA' });

    expect(error?.code).toBe('23505');
    expect(capture.lines()).toEqual([]);
  });
});
