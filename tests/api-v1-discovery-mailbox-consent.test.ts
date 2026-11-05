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
import { DELETE, GET, POST } from '@/app/api/v1/discovery/mailbox-consent/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);
const admin = vi.mocked(createSupabaseAdminClient);

const STATUS = { eligible: true, consented: true, since: '2026-09-29T10:00:00Z', address: 'storm.duncan@bank.example' };

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(results: Record<string, RpcResult> = {}) {
  const rpc = vi.fn(async (name: string): Promise<RpcResult> => results[name] ?? { data: STATUS, error: null });
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

const VERBS = { GET, POST, DELETE } as const;

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('/api/v1/discovery/mailbox-consent', () => {
  it('POST is 404 when deal_discovery is off, and never reaches the session', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await POST();
    expect(res.status).toBe(404);
    expect(scoped).not.toHaveBeenCalled();
    expect(flag).toHaveBeenCalledWith('deal_discovery');
  });

  // Withdrawal is always reachable (audit round 1, item 20): a member who
  // consented can see the status and stop, whatever the flag says.
  it.each([
    ['GET', GET, 'mailbox_consent_status'],
    ['DELETE', DELETE, 'mailbox_consent_withdraw'],
  ] as const)('%s works when deal_discovery is off', async (_name, handler, rpcName) => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const rpc = signedIn();
    const res = await handler();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rpcName === 'mailbox_consent_withdraw' ? { ...STATUS, purged: null } : STATUS);
    expect(rpc.mock.calls.map((c) => c[0])[0]).toBe(rpcName);
    expect(flag).not.toHaveBeenCalled();
  });

  it.each(Object.entries(VERBS))('%s returns the scoped helper 401 when unauthenticated', async (_name, handler) => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    const res = await handler();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('GET returns the RPC status', async () => {
    const rpc = signedIn();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['mailbox_consent_status']);
  });

  it('GET is 500 when the status RPC fails', async () => {
    signedIn({ mailbox_consent_status: { data: null, error: { code: 'XX000', message: 'boom' } } });
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it('POST grants, then returns the status', async () => {
    const rpc = signedIn();
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(STATUS);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['mailbox_consent_grant', 'mailbox_consent_status']);
  });

  it('POST maps the exact 42501 not_eligible error to 403', async () => {
    const rpc = signedIn({ mailbox_consent_grant: { data: null, error: { code: '42501', message: 'not_eligible' } } });
    const res = await POST();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_eligible' });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['mailbox_consent_grant']);
  });

  it.each([
    { code: '42501', message: 'not_authenticated' },
    { code: '42501', message: 'new row violates not_eligible policy' },
    { code: 'P0001', message: 'not_eligible' },
    { code: 'XX000', message: 'boom' },
  ])('POST maps any other error to 500 ($code $message)', async (error) => {
    signedIn({ mailbox_consent_grant: { data: null, error } });
    const res = await POST();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not save mailbox consent' });
  });

  it('DELETE withdraws, then returns the status with what the purge deleted (#461)', async () => {
    const purged = { provenance: 4, ledger: 9, taints: 0, items: 2, texts: 2, evidence: 2, milestones: 0, modelCalls: 0,
                     candidates: 1, corrections: 0, heldSkipped: 0 };
    const rpc = signedIn({
      mailbox_consent_withdraw: { data: { consented: false, purged }, error: null },
      mailbox_consent_status: { data: { eligible: true, consented: false }, error: null },
    });
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible: true, consented: false, purged });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['mailbox_consent_withdraw', 'mailbox_consent_status']);
  });

  it('DELETE says purged null when there was no mailbox source to purge', async () => {
    signedIn({
      mailbox_consent_withdraw: { data: { consented: false, purged: null }, error: null },
      mailbox_consent_status: { data: { eligible: true, consented: false }, error: null },
    });
    expect(await (await DELETE()).json()).toEqual({ eligible: true, consented: false, purged: null });
  });

  it('DELETE is 500 when the status after the withdrawal cannot be read', async () => {
    signedIn({
      mailbox_consent_withdraw: { data: { consented: false, purged: null }, error: null },
      mailbox_consent_status: { data: null, error: { code: 'XX000', message: 'boom' } },
    });
    expect((await DELETE()).status).toBe(500);
  });

  it('DELETE is 500 when the withdraw RPC fails', async () => {
    signedIn({ mailbox_consent_withdraw: { data: null, error: { code: 'XX000', message: 'boom' } } });
    const res = await DELETE();
    expect(res.status).toBe(500);
  });

  it('never builds a service-role client', async () => {
    signedIn();
    await GET();
    await POST();
    await DELETE();
    expect(admin).not.toHaveBeenCalled();
  });
});
