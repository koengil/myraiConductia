// PATCH/DELETE /api/v1/companies/[companyId]/members/[userId] — the delegated
// invite-right toggle (idempotent short-circuit, audited restorable writes)
// and the removal lifecycle (company-managed state must not survive removal).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/api/v1/access', () => ({
  canManageCompanyMembers: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/lib/api/v1/companyAccess', () => ({
  getCompanyEffectivePermissionsChecked: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  isFlagEnabled: vi.fn((key: string) => Promise.resolve(key === 'platform_onboarding')),
}));

import { DELETE, PATCH } from '@/app/api/v1/companies/[companyId]/members/[userId]/route';
import { canManageCompanyMembers } from '@/lib/api/v1/access';
import { getCompanyEffectivePermissionsChecked } from '@/lib/api/v1/companyAccess';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';

type Resp = { data: unknown; error: { message: string } | null };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const updates: Array<{ table: string; payload: unknown }> = [];
  const from = vi.fn((table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.update = (payload: unknown) => {
      updates.push({ table, payload });
      return builder;
    };
    builder.insert = chain;
    builder.eq = chain;
    builder.is = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) => Promise.resolve(resp).then(onFulfilled);
    return builder;
  });
  const rpc = vi.fn(() => Promise.resolve({ data: null, error: null }));
  return { from, rpc, updates } as unknown as ReturnType<typeof createSupabaseAdminClient> & {
    from: ReturnType<typeof vi.fn>;
    rpc: ReturnType<typeof vi.fn>;
    updates: Array<{ table: string; payload: unknown }>;
  };
}

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: 'dir-1', email: 'md@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }),
      },
    },
  } as never);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
}

const activeStatus: Resp = { data: { status: 'active' }, error: null };
const ctx = { params: Promise.resolve({ companyId: 'c1', userId: 'u2' }) };
const req = (canInvite: boolean) =>
  new Request('http://test/api/v1/companies/c1/members/u2', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ canInvite }),
  });
const row = (canInvite: boolean): Resp => ({
  data: {
    id: 'u2',
    email: 'alex@bank.dev',
    company_id: 'c1',
    company_role: 'member',
    can_invite: canInvite,
    preferred_deal_role: null,
    department: 'ib',
    is_external: false,
  },
  error: null,
});

const roleReq = (preferredDealRole: unknown) =>
  new Request('http://test/api/v1/companies/c1/members/u2', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preferredDealRole }),
  });

const roleRow = (
  preferred: string | null,
  extra: Partial<{ department: string | null; is_external: boolean }> = {},
): Resp => ({
  data: {
    id: 'u2',
    email: 'alex@bank.dev',
    company_id: 'c1',
    company_role: 'member',
    can_invite: false,
    preferred_deal_role: preferred,
    department: extra.department ?? 'ib',
    is_external: extra.is_external ?? false,
  },
  error: null,
});

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(isFlagEnabled).mockImplementation((key) =>
    Promise.resolve(key === 'platform_onboarding'),
  );
  vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValue([]);
});

describe('PATCH members/[userId] can_invite', () => {
  it('routes a flag-off grant through the authoritative access transaction', async () => {
    vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValueOnce([
      {
        permissionKey: 'company:invites:send',
        source: {
          type: 'role',
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Inviter',
        },
      },
    ]);
    const admin = makeAdmin({
      users: [activeStatus, row(false)],
      company_member_access: { data: { version: 4 }, error: null },
      company_member_roles: { data: [{ role_id: '22222222-2222-4222-8222-222222222222' }], error: null },
      company_member_permissions: {
        data: [{ permission_key: 'company:directory:view_all' }],
        error: null,
      },
    });
    signedIn(admin);

    const res = await PATCH(req(true), ctx);

    expect(res.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith('replace_company_member_access', {
      p_actor_id: 'dir-1',
      p_company_id: 'c1',
      p_user_id: 'u2',
      p_expected_version: 4,
      p_role_ids: ['22222222-2222-4222-8222-222222222222'],
      p_direct_permission_keys: [
        'company:directory:view_all',
        'company:invites:send',
      ],
    });
    const body = await res.json();
    expect(body.invite_permission).toMatchObject({ effective: true, direct: true });
    expect(admin.from).not.toHaveBeenCalledWith('audit_log');
  });

  it('routes a flag-off revocation through the authoritative access transaction', async () => {
    const admin = makeAdmin({
      users: [activeStatus, row(true)],
      company_member_access: { data: { version: 7 }, error: null },
      company_member_roles: { data: [], error: null },
      company_member_permissions: {
        data: [
          { permission_key: 'company:invites:send' },
          { permission_key: 'company:directory:view_all' },
        ],
        error: null,
      },
    });
    signedIn(admin);

    const res = await PATCH(req(false), ctx);

    expect(res.status).toBe(200);
    expect(admin.rpc).toHaveBeenCalledWith('replace_company_member_access', {
      p_actor_id: 'dir-1',
      p_company_id: 'c1',
      p_user_id: 'u2',
      p_expected_version: 7,
      p_role_ids: [],
      p_direct_permission_keys: ['company:directory:view_all'],
    });
    const body = await res.json();
    expect(body.member.can_invite).toBe(false);
    expect(body.invite_permission).toMatchObject({ effective: false, direct: false });
    expect(admin.from).not.toHaveBeenCalledWith('audit_log');
  });

  it('reports inherited invite authority after removing a direct grant', async () => {
    vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValueOnce([
      {
        permissionKey: 'company:invites:send',
        source: {
          type: 'role',
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Inviter',
        },
      },
    ]);
    const admin = makeAdmin({
      users: [activeStatus, row(true)],
      company_member_access: { data: { version: 2 }, error: null },
      company_member_roles: {
        data: [{ role_id: '11111111-1111-4111-8111-111111111111' }],
        error: null,
      },
      company_member_permissions: {
        data: [{ permission_key: 'company:invites:send' }],
        error: null,
      },
    });
    signedIn(admin);

    const res = await PATCH(req(false), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.member.can_invite).toBe(true);
    expect(body.invite_permission).toMatchObject({ effective: true, direct: false });
  });
});

describe('PATCH members/[userId] preferred_deal_role', () => {
  it('sets a preferred role and audits a grant', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null), roleRow('legal')],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { member: { preferred_deal_role: string } };
    expect(body.member.preferred_deal_role).toBe('legal');
    expect(admin.from).toHaveBeenCalledWith('audit_log');
  });

  it('clears a preferred role and audits a revoke', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow('legal'), roleRow(null)],
      audit_log: { data: null, error: null },
    });
    signedIn(admin);
    const res = await PATCH(roleReq(null), ctx);
    expect(res.status).toBe(200);
  });

  it.each(['md', 'seller', 'buyer', 'admin', 'cco', 'bogus', true])(
    'rejects disallowed value %s with 400',
    async (value) => {
      const admin = makeAdmin({ users: [activeStatus] });
      signedIn(admin);
      const res = await PATCH(roleReq(value), ctx);
      expect(res.status).toBe(400);
    },
  );

  it('rejects a request carrying both fields', async () => {
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const res = await PATCH(
      new Request('http://test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ canInvite: true, preferredDealRole: 'legal' }),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a request carrying neither field', async () => {
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const res = await PATCH(
      new Request('http://test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it('rejects non-object bodies and unknown fields', async () => {
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const requestWith = (body: unknown) =>
      new Request('http://test/x', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await PATCH(requestWith(null), ctx)).status).toBe(400);
    expect(
      (
        await PATCH(
          requestWith({ preferredDealRole: 'legal', unexpected: true }),
          ctx,
        )
      ).status,
    ).toBe(400);
  });

  it('rejects a walled target', async () => {
    const admin = makeAdmin({ users: [activeStatus, roleRow(null, { department: 'research' })] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(403);
  });

  it('rejects an external target', async () => {
    const admin = makeAdmin({ users: [activeStatus, roleRow(null, { is_external: true })] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(403);
  });

  it('rejects a non-member target', async () => {
    const admin = makeAdmin({ users: [activeStatus, { data: null, error: null }] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(404);
  });

  it('rejects a non-manager actor', async () => {
    vi.mocked(canManageCompanyMembers).mockResolvedValueOnce(false);
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(403);
  });

  it('rejects when platform_onboarding is off', async () => {
    vi.mocked(isFlagEnabled).mockResolvedValueOnce(false);
    const admin = makeAdmin({ users: [activeStatus] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(400);
  });

  it('short-circuits an idempotent role write without auditing', async () => {
    const admin = makeAdmin({ users: [activeStatus, roleRow('legal')] });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(200);
    expect(admin.from).not.toHaveBeenCalledWith('audit_log');
  });

  it('409s when the role changed concurrently', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null), { data: null, error: null }],
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(409);
  });

  it('restores the previous role when the audit write fails', async () => {
    const admin = makeAdmin({
      users: [activeStatus, roleRow(null), roleRow('legal'), { data: null, error: null }],
      audit_log: { data: null, error: { message: 'audit store down' } },
    });
    signedIn(admin);
    const res = await PATCH(roleReq('legal'), ctx);
    expect(res.status).toBe(500);
    const userCalls = admin.from.mock.calls.filter((call) => call[0] === 'users');
    expect(userCalls.length).toBe(4);
  });
});

describe('DELETE members/[userId] lifecycle', () => {
  it('clears the company-managed preferred role on removal', async () => {
    const admin = makeAdmin({
      users: [
        activeStatus,
        { data: { id: 'u2', company_id: 'c1' }, error: null },
        { data: null, error: null },
      ],
      deal_memberships: { data: [], error: null },
    });
    signedIn(admin);
    const res = await DELETE(
      new Request('http://test/api/v1/companies/c1/members/u2', { method: 'DELETE' }),
      ctx,
    );
    expect(res.status).toBe(200);
    const removal = admin.updates.find((u) => u.table === 'users');
    expect(removal?.payload).toMatchObject({
      company_id: null,
      company_role: null,
      can_invite: false,
      preferred_deal_role: null,
    });
  });
});
