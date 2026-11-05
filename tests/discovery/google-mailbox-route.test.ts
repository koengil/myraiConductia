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
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import * as googleMailboxRoute from '@/app/api/v1/discovery/google-mailbox/route';
import { GET } from '@/app/api/v1/discovery/google-mailbox/route';
import { PATCH } from '@/app/api/v1/discovery/sources/[sourceId]/status/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);
const admin = vi.mocked(createSupabaseAdminClient);

const STATUS = {
  connected: true,
  address: 'storm.duncan@bank.example',
  group: 'conductia-ingest@bank.example',
  domain: 'bank.example',
  paused: false,
  waitingForGroup: true,
  state: 'up_to_date',
  backfillCompletedAt: '2026-10-16T09:00:00.000Z',
  lastSyncedAt: '2026-10-16T10:55:00.000Z',
  delegationRefused: false,
};
const SOURCE = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(results: Record<string, RpcResult> = {}) {
  const rpc = vi.fn(async (name: string): Promise<RpcResult> => results[name] ?? { data: STATUS, error: null });
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

const NOT_SIGNED_IN = () =>
  scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });

function patch(sourceId: string, body: unknown) {
  return PATCH(
    new Request('http://localhost/api/v1/discovery/sources/x/status', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ sourceId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('/api/v1/discovery/google-mailbox', () => {
  it('is 404 when deal_discovery is off, and never reaches the session', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(scoped).not.toHaveBeenCalled();
    expect(flag).toHaveBeenCalledWith('deal_discovery');
  });

  it('returns the scoped helper 401 when unauthenticated', async () => {
    NOT_SIGNED_IN();
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('GET returns the RPC status', async () => {
    const rpc = signedIn();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['discovery_google_mailbox_status']);
  });

  it('GET passes the first-sync status through, and fills it in for an older database that omits it (#341)', async () => {
    const { state, backfillCompletedAt, lastSyncedAt, delegationRefused, ...older } = STATUS;
    void [state, backfillCompletedAt, lastSyncedAt, delegationRefused];
    signedIn({ discovery_google_mailbox_status: { data: older, error: null } });
    expect(await (await GET()).json()).toEqual({
      ...older,
      state: null,
      backfillCompletedAt: null,
      lastSyncedAt: null,
      delegationRefused: false,
    });
  });

  it('GET drops a state outside the health states, and any key the contract does not name', async () => {
    signedIn({
      discovery_google_mailbox_status: { data: { ...STATUS, state: 'exploded', subject: 'Project Falcon', delegationRefused: true }, error: null },
    });
    const body = await (await GET()).json();
    expect(body.state).toBeNull();
    expect(body.delegationRefused).toBe(true);
    expect(body).not.toHaveProperty('subject');
  });

  it('GET answers a disconnected member with connected false and nothing else', async () => {
    signedIn({ discovery_google_mailbox_status: { data: { connected: false }, error: null } });
    expect(await (await GET()).json()).toEqual({ connected: false });
  });

  it('GET is 500 when the status RPC fails', async () => {
    signedIn({ discovery_google_mailbox_status: { data: null, error: { code: 'XX000', message: 'boom' } } });
    expect((await GET()).status).toBe(500);
  });

  it('has no connect path: opting in is #262 mailbox-consent, so this route exports GET only', () => {
    expect(Object.keys(googleMailboxRoute).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(['GET']);
  });

  it('never builds a service-role client', async () => {
    signedIn();
    await GET();
    await patch(SOURCE, { status: 'paused' });
    expect(admin).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/discovery/sources/[sourceId]/status', () => {
  it('returns the scoped helper 401 when unauthenticated', async () => {
    NOT_SIGNED_IN();
    const res = await patch(SOURCE, { status: 'paused' });
    expect(res.status).toBe(401);
  });

  it('is not behind deal_discovery: a control that stops reading stays reachable', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    signedIn({ discovery_set_mailbox_source_status: { data: { id: SOURCE, status: 'paused', changed: true }, error: null } });
    const res = await patch(SOURCE, { status: 'paused' });
    expect(res.status).toBe(200);
    expect(flag).not.toHaveBeenCalled();
  });

  it.each(['paused', 'active'] as const)('calls the RPC with %s under the caller session', async (status) => {
    const rpc = signedIn({ discovery_set_mailbox_source_status: { data: { id: SOURCE, status, changed: true }, error: null } });
    const res = await patch(SOURCE, { status });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: SOURCE, status, changed: true });
    expect(rpc).toHaveBeenCalledWith('discovery_set_mailbox_source_status', { p_source_id: SOURCE, p_status: status });
  });

  it.each([
    ['a status outside active and paused', SOURCE, { status: 'deleted' }],
    ['a missing status', SOURCE, {}],
    ['a non-uuid source id', 'not-a-uuid', { status: 'paused' }],
    ['a body that is not JSON', SOURCE, '{'],
    ['a body that is not an object', SOURCE, 'null'],
  ] as const)('is 400 for %s, and never reaches the RPC', async (_label, sourceId, body) => {
    const rpc = signedIn();
    const res = await patch(sourceId, body);
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('answers 404 to the RPC 42501 refusal, whatever the reason', async () => {
    signedIn({ discovery_set_mailbox_source_status: { data: null, error: { code: '42501', message: 'not_available' } } });
    const res = await patch(SOURCE, { status: 'paused' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('answers 500 to any other RPC failure', async () => {
    signedIn({ discovery_set_mailbox_source_status: { data: null, error: { code: 'XX000', message: 'boom' } } });
    expect((await patch(SOURCE, { status: 'paused' })).status).toBe(500);
  });
});
