import { describe, it, expect, vi, beforeEach } from 'vitest';

import { apiV1, ApiV1Error } from '@/lib/api/v1Client';

function respond(status: number, body?: unknown) {
  global.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  }) as Response) as unknown as typeof fetch;
}

describe('apiV1', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends JSON to /api/v1 and resolves with the parsed body', async () => {
    respond(200, { deal: { code: 'D-1' } });
    await expect(apiV1('PATCH', '/deals/D-1/progress', { currentStepSeq: 3 })).resolves.toEqual({ deal: { code: 'D-1' } });
    const [url, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(url).toBe('/api/v1/deals/D-1/progress');
    expect(init).toMatchObject({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"currentStepSeq":3}' });
  });

  it('sends no body or content type without a body, and resolves undefined on 204', async () => {
    respond(204);
    await expect(apiV1('DELETE', '/x')).resolves.toBeUndefined();
    expect(vi.mocked(global.fetch).mock.calls[0][1]).toMatchObject({ headers: undefined, body: undefined });
  });

  it('throws on any non-2xx with the handler message, shown to users only for a 4xx', async () => {
    respond(403, { error: 'Only the deal MD can move the rail backwards' });
    const refused = await apiV1('PATCH', '/x', {}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiV1Error);
    expect(refused).toMatchObject({ status: 403, userMessage: 'Only the deal MD can move the rail backwards' });

    respond(500, { error: 'duplicate key value violates unique constraint' });
    const failed = await apiV1('PATCH', '/x', {}).catch((e: unknown) => e);
    expect(failed).toMatchObject({ status: 500, userMessage: null, serverMessage: 'duplicate key value violates unique constraint' });
  });

  it('throws a status-0 error when no response arrives, and rethrows an abort', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(apiV1('GET', '/x')).rejects.toMatchObject({ status: 0 });

    global.fetch = vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    await expect(apiV1('GET', '/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('on a 401 calls onUnauthorized (default: sign in again) and still throws', async () => {
    respond(401, { error: 'Unauthorized' });
    const onUnauthorized = vi.fn();
    await expect(apiV1('GET', '/me', undefined, { onUnauthorized })).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
