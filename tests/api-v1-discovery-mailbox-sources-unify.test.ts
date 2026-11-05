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
import { POST } from '@/app/api/v1/discovery/mailbox-sources/unify/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);
const admin = vi.mocked(createSupabaseAdminClient);

const ARCHIVED = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const RESULT = { archivedSourceId: ARCHIVED, targetSourceId: TARGET, moved: 2, alreadyLinked: 1, candidatesRefreshed: 1 };

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(result: RpcResult = { data: RESULT, error: null }) {
  const rpc = vi.fn<(name: string, args?: unknown) => Promise<RpcResult>>(async () => result);
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

const body = (value: unknown) =>
  new Request('http://localhost/api/v1/discovery/mailbox-sources/unify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
const valid = () => body({ archivedSourceId: ARCHIVED, targetSourceId: TARGET });

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('POST /api/v1/discovery/mailbox-sources/unify', () => {
  it('is 404 when deal_discovery is off, without touching the session', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await POST(valid());
    expect(res.status).toBe(404);
    expect(flag).toHaveBeenCalledWith('deal_discovery');
    expect(scoped).not.toHaveBeenCalled();
  });

  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    const res = await POST(valid());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('calls the RPC under the caller session with both ids and returns its result', async () => {
    const rpc = signedIn();
    const res = await POST(valid());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(rpc.mock.calls).toEqual([['discovery_unify_mailbox_sources', { p_archived: ARCHIVED, p_target: TARGET }]]);
    expect(admin).not.toHaveBeenCalled();
  });

  it.each([
    { code: '42501', message: 'not_authorized', status: 403 },
    { code: '42501', message: 'not_authenticated', status: 403 },
    { code: '22023', message: 'invalid_unify_request', status: 400 },
    { code: 'P0001', message: 'unify_source_not_found', status: 404 },
    { code: 'P0001', message: 'unify_not_archived', status: 409 },
    { code: 'P0001', message: 'unify_already_unified', status: 409 },
    { code: 'P0001', message: 'unify_address_mismatch', status: 409 },
    { code: 'P0001', message: 'unify_target_not_active', status: 409 },
    { code: 'P0001', message: 'unify_provider_mismatch', status: 409 },
    { code: 'P0001', message: 'unify_target_not_allowlisted', status: 409 },
  ])('maps $code $message to $status', async ({ code, message, status }) => {
    signedIn({ data: null, error: { code, message } });
    const res = await POST(valid());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: message });
  });

  it('answers the RPC\'s own flag refusal as the flag-off route does: 404 Not found', async () => {
    signedIn({ data: null, error: { code: 'P0001', message: 'unify_discovery_disabled' } });
    const res = await POST(valid());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it.each([
    { code: '42501', message: 'unify_already_unified' },
    { code: 'P0001', message: 'not_authorized' },
    { code: 'P0001', message: 'unify_already_unified: extra' },
    { code: '42501', message: 'unify_discovery_disabled' },
    { code: 'P0001', message: 'unify_target_not_active: extra' },
    { code: 'P0001', message: 'site_admin_not_firm_admin' },
    { code: 'XX000', message: 'boom' },
  ])('maps a near miss to 500 ($code $message) without echoing the message', async (error) => {
    signedIn({ data: null, error });
    const res = await POST(valid());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not merge the mailbox sources' });
  });

  it.each([
    ['a missing archived id', { targetSourceId: TARGET }],
    ['a missing target id', { archivedSourceId: ARCHIVED }],
    ['a non-string id', { archivedSourceId: 7, targetSourceId: TARGET }],
    ['a malformed id', { archivedSourceId: 'not-a-uuid', targetSourceId: TARGET }],
    ['a null body', null],
    ['a non-object body', 'text'],
    ['a body that is not JSON', '{not json'],
  ])('is 400 for %s, without calling the RPC', async (_label, value) => {
    const rpc = signedIn();
    const res = await POST(body(value));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
