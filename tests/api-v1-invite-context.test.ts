/**
 * GET /api/v1/invites/context authorization (cr-prr-124-r2 1.1): the invite
 * id in auth metadata is client-mutable, so the route must bind the invite to
 * the authenticated email and tenant — mismatches 404 exactly like a missing
 * invite.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(async () => null),
  isFlagEnabled: vi.fn(async () => true),
}));
vi.mock('@/lib/api/v1/inviteDelivery', () => ({
  fetchInviteEmailContext: vi.fn(async () => ({
    inviterName: 'Storm Duncan',
    companyName: 'Vista Equity Partners',
    companyType: 'acquirer',
    dealCodename: 'Project Rangers',
  })),
}));

import { GET } from '@/app/api/v1/invites/context/route';
import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';

type Resp = { data: unknown; error: { message: string } | null };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  return {
    from: vi.fn((table: string) => {
      const entry = tables[table];
      const resp: Resp = Array.isArray(entry)
        ? (entry.shift() ?? { data: null, error: null })
        : (entry ?? { data: null, error: null });
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => resp,
      };
      return builder;
    }),
  } as never;
}

function signedIn(admin: unknown, email: string, inviteId: string | null) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: 'u1',
            email,
            user_metadata: inviteId
              ? { invite_id: inviteId, credential_nonce: 'nonce-1' }
              : {},
          },
        },
        error: null,
      }),
    },
  } as never);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
}

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

function inviteRow(overrides: Record<string, unknown> = {}): Resp {
  return {
    data: {
      id: 'inv-1',
      email: 'director@vista.com',
      tenant_id: 't1',
      invited_by: 'md-1',
      company_id: 'comp-1',
      deal_id: 'd1',
      status: 'pending',
      delivery_status: 'sent',
      expires_at: FUTURE,
      credential_nonce: 'nonce-1',
      challenge_digest: 'a'.repeat(64),
      challenge_version: 1,
      challenge_verified_at: new Date().toISOString(),
      challenge_verified_user_id: 'u1',
      challenge_verified_version: 1,
      challenge_locked_at: null,
      ...overrides,
    },
    error: null,
  };
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/invites/context — identity binding', () => {
  it('returns context when the invite matches the authenticated email and tenant', async () => {
    const admin = makeAdmin({
      invites: inviteRow(),
      users: { data: { tenant_id: 't1' }, error: null },
    });
    signedIn(admin, 'director@vista.com', 'inv-1');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'pending',
      inviterName: 'Storm Duncan',
      companyName: 'Vista Equity Partners',
      dealCodename: 'Project Rangers',
      verificationRequired: false,
    });
  });

  it('withholds confidential context until the current challenge is verified', async () => {
    const admin = makeAdmin({
      invites: inviteRow({ challenge_verified_at: null, challenge_verified_user_id: null }),
      users: { data: { tenant_id: 't1' }, error: null },
    });
    signedIn(admin, 'director@vista.com', 'inv-1');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'pending',
      email: 'director@vista.com',
      verificationRequired: true,
      locked: false,
    });
  });

  it('404s a cross-account read: metadata points at another user\'s invite', async () => {
    const admin = makeAdmin({
      invites: inviteRow({ email: 'someone-else@target.com' }),
      users: { data: { tenant_id: 't1' }, error: null },
    });
    signedIn(admin, 'attacker@evil.dev', 'inv-1');
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Invite not found');
  });

  it('404s a cross-tenant read even when the email matches', async () => {
    const admin = makeAdmin({
      invites: inviteRow(),
      users: { data: { tenant_id: 't2' }, error: null },
    });
    signedIn(admin, 'director@vista.com', 'inv-1');
    const res = await GET();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Invite not found');
  });

  it('409s when no invite is attached to the account', async () => {
    const admin = makeAdmin({});
    signedIn(admin, 'director@vista.com', null);
    const res = await GET();
    expect(res.status).toBe(409);
  });
});
