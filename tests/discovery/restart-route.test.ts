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
import { POST } from '@/app/api/v1/discovery/sources/[sourceId]/restart/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);

const SOURCE = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(result: RpcResult = { data: { id: SOURCE, restarted: true }, error: null }) {
  const rpc = vi.fn(async (): Promise<RpcResult> => result);
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

function post(sourceId: string) {
  return POST(new Request('http://localhost/api/v1/discovery/sources/x/restart', { method: 'POST' }), {
    params: Promise.resolve({ sourceId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('POST /api/v1/discovery/sources/[sourceId]/restart', () => {
  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await post(SOURCE)).status).toBe(401);
  });

  it('is 400 for a non-uuid source id, and never reaches the RPC', async () => {
    const rpc = signedIn();
    const res = await post('not-a-uuid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'sourceId must be a UUID' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls the RPC under the caller session and answers { id, restarted }', async () => {
    const rpc = signedIn();
    const res = await post(SOURCE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SOURCE, restarted: true });
    expect(rpc).toHaveBeenCalledWith('discovery_restart_mailbox_source', { p_source_id: SOURCE });
  });

  it('answers 404 to the RPC 42501 refusal, whatever the reason', async () => {
    signedIn({ data: null, error: { code: '42501', message: 'not_available' } });
    const res = await post(SOURCE);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('answers 500 to any other RPC failure, without the database message', async () => {
    signedIn({ data: null, error: { code: 'XX000', message: 'relation content_sources is on fire' } });
    const res = await post(SOURCE);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('on fire');
  });

  it('is not behind deal_discovery: a recovery control stays reachable', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    signedIn();
    expect((await post(SOURCE)).status).toBe(200);
    expect(flag).not.toHaveBeenCalled();
  });
});
