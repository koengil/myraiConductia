import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn(async () => null) }));
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return {
    ...actual,
    requireApiUser: vi.fn(async () => ({ ok: true, user: { id: 'u1' }, admin: {} })),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: vi.fn() }));

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { POST } from '@/app/api/v1/invites/verify/route';

beforeAll(() => {
  process.env.INVITE_VERIFICATION_PEPPER = 'verify-route-test-pepper';
});
afterEach(() => vi.clearAllMocks());

function request(code: string) {
  return new Request('http://localhost/api/v1/invites/verify', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

function sessionClient(result: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn(async (_name: string, _params: Record<string, string>) => result);
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            user_metadata: { invite_id: 'inv-1', credential_nonce: 'nonce-1' },
          },
        },
      }),
    },
    rpc,
  } as never);
  return rpc;
}

describe('POST /api/v1/invites/verify', () => {
  it('passes only the digest and current credential binding to the RPC', async () => {
    const rpc = sessionClient({ data: { verified: true }, error: null });
    const res = await POST(request('123456'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true, attemptsRemaining: 5, locked: false });
    const params = rpc.mock.calls[0][1];
    expect(params).toMatchObject({ p_invite_id: 'inv-1', p_nonce: 'nonce-1' });
    expect(params.p_code_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(params)).not.toContain('123456');
  });

  it('reports remaining attempts and the fifth-failure lock without oracle details', async () => {
    sessionClient({
      data: { verified: false, attempts_remaining: 0, locked: true },
      error: null,
    });
    const res = await POST(request('000000'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ verified: false, attemptsRemaining: 0, locked: true });
  });
});
