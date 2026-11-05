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
import { DELETE, GET, POST } from '@/app/api/v1/discovery/sites/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);
const admin = vi.mocked(createSupabaseAdminClient);

const ADDRESS = 'bank.sharepoint.com:/sites/deals';
const LIST = [{ address: ADDRESS, registeredAt: '2026-09-29T10:00:00Z', registeredBy: 'u1' }];

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(results: Record<string, RpcResult> = {}) {
  const rpc = vi.fn<(name: string, args?: unknown) => Promise<RpcResult>>(
    async (name) => results[name] ?? { data: LIST, error: null },
  );
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

const body = (value: unknown) =>
  new Request('http://localhost/api/v1/discovery/sites', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });

const VERBS = {
  GET: () => GET(),
  POST: () => POST(body({ address: ADDRESS })),
  DELETE: () => DELETE(body({ address: ADDRESS })),
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('/api/v1/discovery/sites', () => {
  // Listing and registering are product surfaces: they answer 404 while deal_discovery is off.
  it.each(Object.entries({ GET: VERBS.GET, POST: VERBS.POST }))('%s is 404 when deal_discovery is off', async (_name, call) => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await call();
    expect(res.status).toBe(404);
    expect(scoped).not.toHaveBeenCalled();
    expect(flag).toHaveBeenCalledWith('deal_discovery');
  });

  // C16: withdrawal is always reachable, like mailbox consent. An admin who registered a site can stop it
  // while the flag is off, so turning the flag off never strands a registration the worker would still read.
  it('DELETE is never gated: it unregisters while deal_discovery is off', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const rpc = signedIn({ discovery_site_registrations: { data: [], error: null } });
    const res = await DELETE(body({ address: ADDRESS }));
    expect(res.status).toBe(200);
    expect(flag).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['site_unregister', 'discovery_site_registrations']);
  });

  it.each(Object.entries(VERBS))('%s returns the scoped helper 401 when unauthenticated', async (_name, call) => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('GET returns the registrations list', async () => {
    const rpc = signedIn();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sites: LIST });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['discovery_site_registrations']);
  });

  it('GET answers an empty list for a null result', async () => {
    signedIn({ discovery_site_registrations: { data: null, error: null } });
    const res = await GET();
    expect(await res.json()).toEqual({ sites: [] });
  });

  it('GET maps the exact 42501 not_authorized error to 403 and any other error to 500', async () => {
    signedIn({ discovery_site_registrations: { data: null, error: { code: '42501', message: 'not_authorized' } } });
    expect((await GET()).status).toBe(403);
    signedIn({ discovery_site_registrations: { data: null, error: { code: 'XX000', message: 'boom' } } });
    expect((await GET()).status).toBe(500);
  });

  it('POST registers the address, then returns the list', async () => {
    const rpc = signedIn();
    const res = await POST(body({ address: ADDRESS }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sites: LIST });
    expect(rpc.mock.calls).toEqual([
      ['site_register', { p_address: ADDRESS }],
      ['discovery_site_registrations'],
    ]);
  });

  it('DELETE unregisters the address, then returns the list', async () => {
    const rpc = signedIn({ discovery_site_registrations: { data: [], error: null } });
    const res = await DELETE(body({ address: ADDRESS }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sites: [] });
    expect(rpc.mock.calls).toEqual([
      ['site_unregister', { p_address: ADDRESS }],
      ['discovery_site_registrations'],
    ]);
  });

  describe.each([
    ['POST', 'site_register', (b: Request) => POST(b)],
    ['DELETE', 'site_unregister', (b: Request) => DELETE(b)],
  ] as const)('%s error mapping', (_verb, rpcName, call) => {
    it.each([
      { code: '42501', message: 'not_authorized', status: 403 },
      { code: '42501', message: 'not_authenticated', status: 403 },
      { code: '22023', message: 'invalid_site_address', status: 400 },
      { code: 'P0001', message: 'registered_by_other_firm', status: 409 },
    ])('maps $code $message to $status', async ({ code, message, status }) => {
      const rpc = signedIn({ [rpcName]: { data: null, error: { code, message } } });
      const res = await call(body({ address: ADDRESS }));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: message });
      expect(rpc.mock.calls.map((c) => c[0])).toEqual([rpcName]);
    });

    it.each([
      { code: '42501', message: 'new row violates not_authorized policy' },
      { code: 'P0001', message: 'not_authorized' },
      { code: '22023', message: 'invalid_site_address: extra' },
      { code: '42501', message: 'registered_by_other_firm' },
      { code: 'P0001', message: 'site_admin_not_firm_admin' },
      { code: 'XX000', message: 'boom' },
    ])('maps a near miss to 500 ($code $message)', async (error) => {
      signedIn({ [rpcName]: { data: null, error } });
      const res = await call(body({ address: ADDRESS }));
      expect(res.status).toBe(500);
    });

    it('is 500 when the list cannot be read after the write', async () => {
      signedIn({ discovery_site_registrations: { data: null, error: { code: 'XX000', message: 'boom' } } });
      const res = await call(body({ address: ADDRESS }));
      expect(res.status).toBe(500);
    });

    it.each([
      ['a missing address', {}],
      ['a non-string address', { address: 42 }],
      ['an empty address', { address: '   ' }],
      ['an oversized address', { address: `bank.sharepoint.com:/sites/${'a'.repeat(400)}` }],
      ['a null body', null],
      ['a non-object body', 'text'],
    ])('is 400 for %s, without calling an RPC', async (_label, value) => {
      const rpc = signedIn();
      const res = await call(body(value));
      expect(res.status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    });

    it('is 400 for a body that is not JSON', async () => {
      const rpc = signedIn();
      const res = await call(body('{not json'));
      expect(res.status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  it('never builds a service-role client', async () => {
    signedIn();
    await GET();
    await POST(body({ address: ADDRESS }));
    await DELETE(body({ address: ADDRESS }));
    expect(admin).not.toHaveBeenCalled();
  });
});
