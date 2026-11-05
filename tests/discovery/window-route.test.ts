// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn() }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { requireFlag } from '@/lib/api/v1/requireFlag';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { PUT } from '@/app/api/v1/discovery/sources/[sourceId]/window/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);

const SOURCE = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(result: RpcResult = { data: { id: SOURCE, backfillSince: '2026-07-17', changed: true }, error: null }) {
  const rpc = vi.fn(async (): Promise<RpcResult> => result);
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

function put(sourceId: string, body: unknown = { since: '2026-07-17' }) {
  return PUT(
    new Request('http://localhost/api/v1/discovery/sources/x/window', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ sourceId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('PUT /api/v1/discovery/sources/[sourceId]/window (#353)', () => {
  it('is behind deal_discovery: 404 when the flag is off, before authenticating', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const rpc = signedIn();
    expect((await put(SOURCE)).status).toBe(404);
    expect(flag).toHaveBeenCalledWith('deal_discovery');
    expect(scoped).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await put(SOURCE)).status).toBe(401);
  });

  it('is 400 for a non-uuid source id, a bad body or a malformed date, and never reaches the RPC', async () => {
    const rpc = signedIn();
    expect((await put('not-a-uuid')).status).toBe(400);
    for (const body of ['{not json', {}, { since: null }, { since: 20260717 }, { since: '17/07/2026' }, { since: '2026-7-17' },
      { since: '2026-07-17T00:00:00Z' }, { since: '2026-02-30' }, { since: '2026-13-01' }]) {
      const res = await put(SOURCE, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls the RPC under the caller session and answers { id, backfillSince, changed }', async () => {
    const rpc = signedIn();
    const res = await put(SOURCE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SOURCE, backfillSince: '2026-07-17', changed: true });
    expect(rpc).toHaveBeenCalledWith('discovery_set_mailbox_source_window', { p_source_id: SOURCE, p_since: '2026-07-17' });
  });

  it('passes a no-op through as changed false', async () => {
    signedIn({ data: { id: SOURCE, backfillSince: '2026-07-17', changed: false }, error: null });
    expect(await (await put(SOURCE)).json()).toEqual({ id: SOURCE, backfillSince: '2026-07-17', changed: false });
  });

  it.each([
    [{ code: '42501', message: 'not_available' }, 404, { error: 'Not found' }],
    [{ code: '22023', message: 'out_of_range' }, 400, { error: 'out_of_range' }],
    [{ code: '55000', message: 'window_locked' }, 409, { error: 'window_locked' }],
  ])('maps the RPC refusal %o to %i', async (error, status, body) => {
    signedIn({ data: null, error });
    const res = await put(SOURCE);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it('answers 500 to any other RPC failure, a look-alike code included, without the database message', async () => {
    for (const error of [
      { code: 'XX000', message: 'relation content_sources is on fire' },
      { code: '42501', message: 'permission denied for content_sources on fire' },
      { code: '22008', message: 'date out of range on fire' },
    ]) {
      signedIn({ data: null, error });
      const res = await put(SOURCE);
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain('on fire');
    }
  });
});
