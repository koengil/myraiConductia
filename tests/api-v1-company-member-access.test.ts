import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn() }));
vi.mock('@/lib/api/v1/http', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/v1/http')>(
    '@/lib/api/v1/http',
  );
  return { ...actual, requireApiUser: vi.fn() };
});
vi.mock('@/lib/api/v1/companyAccess', () => ({
  getCompanyEffectivePermissionsChecked: vi.fn(),
  hasCompanyPermissionChecked: vi.fn(),
}));

import { GET, PATCH } from '@/app/api/v1/companies/[companyId]/members/[userId]/access/route';
import {
  getCompanyEffectivePermissionsChecked,
  hasCompanyPermissionChecked,
} from '@/lib/api/v1/companyAccess';
import { requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';

type ResponseValue = { data: unknown; error: { message: string } | null };

function makeAdmin(
  tableResponses: Record<string, ResponseValue[]>,
  rpcResponse: ResponseValue = { data: {}, error: null },
) {
  const rpc = vi.fn(async () => rpcResponse);
  const from = vi.fn((table: string) => {
    const response = tableResponses[table]?.shift() ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(response);
    for (const method of ['select', 'eq', 'is', 'in', 'order']) builder[method] = chain;
    builder.maybeSingle = terminal;
    builder.single = terminal;
    builder.then = (resolve: (value: ResponseValue) => unknown) =>
      Promise.resolve(response).then(resolve);
    return builder;
  });
  return { admin: { from, rpc }, rpc };
}

const context = {
  params: Promise.resolve({ companyId: 'c1', userId: 'u2' }),
};

beforeEach(() => {
  vi.mocked(requireFlag).mockResolvedValue(null);
  vi.mocked(hasCompanyPermissionChecked).mockResolvedValue(true);
  vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValue([
    {
      permissionKey: 'company:invites:send',
      source: { type: 'direct', id: null, name: null },
    },
  ]);
});

describe('company member access API', () => {
  it('returns 404 while the feature flag is disabled', async () => {
    vi.mocked(requireFlag).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }) as never,
    );
    const response = await GET(new Request('http://test'), context);
    expect(response.status).toBe(404);
    expect(requireApiUser).not.toHaveBeenCalled();
  });

  it('allows an employee to read their own source-aware access', async () => {
    const { admin } = makeAdmin({
      companies: [{ data: { type: 'bank' }, error: null }],
      users: [{ data: { id: 'u2', company_id: 'c1', status: 'active', is_external: false }, error: null }],
      company_member_access: [{ data: { version: 2 }, error: null }],
      company_member_roles: [{ data: [], error: null }],
      company_member_permissions: [
        { data: [{ permission_key: 'company:invites:send' }], error: null },
      ],
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u2', email: 'employee@bank.test' },
      admin,
    } as never);

    const response = await GET(new Request('http://test'), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.access).toMatchObject({
      company_id: 'c1',
      user_id: 'u2',
      version: 2,
      direct_permissions: ['company:invites:send'],
    });
    expect(hasCompanyPermissionChecked).not.toHaveBeenCalled();
  });

  it('denies reading another employee without access-assignment authority', async () => {
    const { admin } = makeAdmin({});
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1', email: 'member@bank.test' },
      admin,
    } as never);
    vi.mocked(hasCompanyPermissionChecked).mockResolvedValue(false);

    const response = await GET(new Request('http://test'), context);
    expect(response.status).toBe(403);
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('rejects unknown or duplicate assignment input', async () => {
    const { admin } = makeAdmin({});
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1', email: 'director@bank.test' },
      admin,
    } as never);

    const unknown = await PATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({ expectedVersion: 0, roleIds: [], directPermissions: [], extra: true }),
      }),
      context,
    );
    expect(unknown.status).toBe(400);

    const duplicate = await PATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: 0,
          roleIds: [],
          directPermissions: ['company:invites:send', 'company:invites:send'],
        }),
      }),
      context,
    );
    expect(duplicate.status).toBe(400);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('allows an external client employee to read their own access', async () => {
    const { admin } = makeAdmin({
      companies: [{ data: { type: 'client' }, error: null }],
      users: [{ data: { id: 'u2', company_id: 'c1', status: 'active', is_external: true }, error: null }],
      company_member_access: [{ data: null, error: null }],
      company_member_roles: [{ data: [], error: null }],
      company_member_permissions: [{ data: [], error: null }],
    });
    vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValue([
      {
        permissionKey: 'company:roles:manage',
        source: { type: 'root', id: null, name: 'Company director' },
      },
    ]);
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u2', email: 'admin@client.test' },
      admin,
    } as never);

    const response = await GET(new Request('http://test'), context);
    expect(response.status).toBe(200);
  });

  it('replaces the exact assignment set and returns the authoritative snapshot', async () => {
    const { admin, rpc } = makeAdmin({
      companies: [{ data: { type: 'bank' }, error: null }],
      users: [{ data: { id: 'u2', company_id: 'c1', status: 'active', is_external: false }, error: null }],
      company_member_access: [{ data: { version: 4 }, error: null }],
      company_member_roles: [{ data: [], error: null }],
      company_member_permissions: [
        { data: [{ permission_key: 'company:invites:send' }], error: null },
      ],
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1', email: 'director@bank.test' },
      admin,
    } as never);

    const response = await PATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: 3,
          roleIds: [],
          directPermissions: ['company:invites:send'],
        }),
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('replace_company_member_access', {
      p_actor_id: 'u1',
      p_company_id: 'c1',
      p_user_id: 'u2',
      p_expected_version: 3,
      p_role_ids: [],
      p_direct_permission_keys: ['company:invites:send'],
    });
    expect((await response.json()).access.version).toBe(4);
  });

  it('maps a stale access version to 409 without loading a snapshot', async () => {
    const { admin } = makeAdmin(
      {
        companies: [{ data: { type: 'bank' }, error: null }],
        users: [
          { data: { id: 'u2', company_id: 'c1', status: 'active', is_external: false }, error: null },
        ],
      },
      { data: null, error: { message: 'stale_version' } },
    );
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1', email: 'director@bank.test' },
      admin,
    } as never);

    const response = await PATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({ expectedVersion: 8, roleIds: [], directPermissions: [] }),
      }),
      context,
    );
    expect(response.status).toBe(409);
  });

  it('maps protected-root assignment attempts to 409', async () => {
    const { admin } = makeAdmin(
      {
        companies: [{ data: { type: 'bank' }, error: null }],
        users: [
          { data: { id: 'u2', company_id: 'c1', status: 'active', is_external: false }, error: null },
        ],
      },
      { data: null, error: { message: 'protected_access_root' } },
    );
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1', email: 'director@bank.test' },
      admin,
    } as never);

    const response = await PATCH(
      new Request('http://test', {
        method: 'PATCH',
        body: JSON.stringify({ expectedVersion: 0, roleIds: [], directPermissions: [] }),
      }),
      context,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Protected company administrators have immutable access',
    });
  });
});
