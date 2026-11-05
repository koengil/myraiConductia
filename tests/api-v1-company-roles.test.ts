import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/v1/http')>();
  return { ...actual, requireApiUser: vi.fn() };
});

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn() }));

vi.mock('@/lib/api/v1/companyAccess', () => ({
  getCompanyEffectivePermissionsChecked: vi.fn(),
  hasCompanyPermission: vi.fn(),
  hasCompanyPermissionChecked: vi.fn(),
}));

import {
  getCompanyEffectivePermissionsChecked,
  hasCompanyPermission,
  hasCompanyPermissionChecked,
} from '@/lib/api/v1/companyAccess';
import { requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { TABLE } from '@/lib/constants/tables';
import { GET, POST } from '@/app/api/v1/companies/[companyId]/roles/route';
import {
  DELETE,
  PATCH,
} from '@/app/api/v1/companies/[companyId]/roles/[roleId]/route';

type Result = { data: unknown; error: unknown; count?: number | null };

function makeAdmin(options: {
  tables?: Record<string, Result>;
  rpc?: Result | Result[];
} = {}) {
  const from = vi.fn((table: string) => {
    const result = options.tables?.[table] ?? { data: [], error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const method of ['select', 'eq', 'is', 'order']) builder[method] = chain;
    builder.then = (resolve: (value: Result) => unknown) => Promise.resolve(result).then(resolve);
    return builder;
  });
  const rpcResults = Array.isArray(options.rpc) ? [...options.rpc] : null;
  const rpc = vi.fn(() =>
    Promise.resolve(
      rpcResults?.shift() ?? options.rpc ?? { data: { id: 'role-1', version: 1 }, error: null },
    ),
  );
  return { from, rpc };
}

const listContext = { params: Promise.resolve({ companyId: 'company-1' }) };
const ROLE_ID = '11111111-1111-4111-8111-111111111111';
const roleContext = {
  params: Promise.resolve({ companyId: 'company-1', roleId: ROLE_ID }),
};

function request(method: string, body?: unknown, suffix = ''): Request {
  return new Request(`http://localhost/api/v1/companies/company-1/roles${suffix}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireFlag).mockResolvedValue(null);
  vi.mocked(hasCompanyPermission).mockResolvedValue(true);
  vi.mocked(hasCompanyPermissionChecked).mockResolvedValue(true);
  vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValue([
    {
      permissionKey: COMPANY_PERMISSION.ROLES_MANAGE,
      source: { type: 'root', id: null, name: 'Company director' },
    },
  ]);
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    user: { id: 'actor-1', email: 'actor@bank.test' },
    admin: makeAdmin(),
  } as never);
});

describe('company role API flag and authorization', () => {
  it('returns the fail-closed 404 before authentication when the flag is off', async () => {
    vi.mocked(requireFlag).mockResolvedValue(
      Response.json({ error: 'Not found' }, { status: 404 }) as never,
    );

    const response = await GET(request('GET'), listContext);

    expect(response.status).toBe(404);
    expect(requireApiUser).not.toHaveBeenCalled();
  });

  it('allows role managers or access assigners to list, and denies everyone else', async () => {
    vi.mocked(hasCompanyPermissionChecked).mockImplementation(
      async (_admin, _userId, _companyId, permission) =>
        permission === COMPANY_PERMISSION.ACCESS_ASSIGN,
    );
    const allowed = await GET(request('GET'), listContext);
    expect(allowed.status).toBe(200);
    expect(hasCompanyPermissionChecked).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'actor-1',
      'company-1',
      COMPANY_PERMISSION.ROLES_MANAGE,
    );
    expect(hasCompanyPermissionChecked).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'actor-1',
      'company-1',
      COMPANY_PERMISSION.ACCESS_ASSIGN,
    );

    vi.mocked(hasCompanyPermissionChecked).mockResolvedValue(false);
    const denied = await GET(request('GET'), listContext);
    expect(denied.status).toBe(403);
  });

  it('fails closed when the permission resolver is unreadable', async () => {
    vi.mocked(hasCompanyPermissionChecked).mockResolvedValue('unreadable');
    const response = await GET(request('GET'), listContext);
    expect(response.status).toBe(500);
  });
});

describe('GET /api/v1/companies/:companyId/roles', () => {
  it('returns the catalogue, active role bundles, counts, versions, and viewer sources', async () => {
    const admin = makeAdmin({
      tables: {
        [TABLE.COMPANY_PERMISSIONS]: {
          data: [
            {
              key: COMPANY_PERMISSION.ROLES_MANAGE,
              label: 'Manage company roles',
              description: 'Create roles.',
              category: 'Access',
              sort_order: 30,
            },
          ],
          error: null,
        },
        [TABLE.COMPANY_ROLES]: {
          data: [
            {
              id: 'role-1',
              name: 'People operations',
              description: null,
              version: 4,
              created_at: '2026-08-14T10:00:00Z',
              updated_at: '2026-08-14T11:00:00Z',
            },
          ],
          error: null,
        },
        [TABLE.COMPANY_ROLE_PERMISSIONS]: {
          data: [
            { role_id: 'role-1', permission_key: COMPANY_PERMISSION.INVITES_SEND },
            { role_id: 'role-1', permission_key: COMPANY_PERMISSION.ACCESS_ASSIGN },
          ],
          error: null,
        },
        [TABLE.COMPANY_MEMBER_ROLES]: {
          data: [{ role_id: 'role-1' }, { role_id: 'role-1' }],
          error: null,
        },
      },
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);

    const response = await GET(request('GET'), listContext);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.permissions).toEqual([
      expect.objectContaining({ key: COMPANY_PERMISSION.ROLES_MANAGE, sortOrder: 30 }),
    ]);
    expect(body.roles).toEqual([
      expect.objectContaining({
        id: 'role-1',
        version: 4,
        assignmentCount: 2,
        permissionKeys: [
          COMPANY_PERMISSION.ACCESS_ASSIGN,
          COMPANY_PERMISSION.INVITES_SEND,
        ],
      }),
    ]);
    expect(admin.rpc).toHaveBeenCalledWith('seed_bank_compliance_role', {
      p_company_id: 'company-1',
      p_actor_id: 'actor-1',
    });
    expect(body.viewerPermissions[0]).toEqual(
      expect.objectContaining({
        permissionKey: COMPANY_PERMISSION.ROLES_MANAGE,
        source: { type: 'root', id: null, name: 'Company director' },
      }),
    );
  });
});

describe('POST /api/v1/companies/:companyId/roles', () => {
  it('strictly validates role input before calling the RPC', async () => {
    const admin = makeAdmin();
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);

    const unknown = await POST(
      request('POST', { name: 'Ops', description: null, permissionKeys: [], extra: true }),
      listContext,
    );
    const duplicate = await POST(
      request('POST', {
        name: 'Ops',
        description: null,
        permissionKeys: [COMPANY_PERMISSION.INVITES_SEND, COMPANY_PERMISSION.INVITES_SEND],
      }),
      listContext,
    );
    const invalid = await POST(
      request('POST', { name: 'Ops', description: null, permissionKeys: ['company:root'] }),
      listContext,
    );

    expect([unknown.status, duplicate.status, invalid.status]).toEqual([400, 400, 400]);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('normalizes input and returns the source-of-truth create result', async () => {
    const admin = makeAdmin({ rpc: { data: { id: 'role-7', version: 1 }, error: null } });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);

    const response = await POST(
      request('POST', {
        name: '  People operations  ',
        description: '  Invite coordinators  ',
        permissionKeys: [COMPANY_PERMISSION.INVITES_SEND],
      }),
      listContext,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ role: { id: 'role-7', version: 1 } });
    expect(admin.rpc).toHaveBeenCalledWith('create_company_role', {
      p_actor_id: 'actor-1',
      p_company_id: 'company-1',
      p_name: 'People operations',
      p_description: 'Invite coordinators',
      p_permission_keys: [COMPANY_PERMISSION.INVITES_SEND],
    });
  });

  it.each([
    ['grant_outside_envelope', 403],
    ['role_name_conflict', 409],
    ['company_not_eligible', 404],
    ['invalid_company_permission', 400],
  ])('maps the %s database error without disclosing internals', async (message, status) => {
    const admin = makeAdmin({ rpc: { data: null, error: { code: 'P0001', message } } });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);
    const response = await POST(
      request('POST', { name: 'Ops', description: null, permissionKeys: [] }),
      listContext,
    );
    expect(response.status).toBe(status);
  });
});

describe('PATCH and DELETE /api/v1/companies/:companyId/roles/:roleId', () => {
  it('returns 404 for a non-UUID role id without calling the database', async () => {
    const admin = makeAdmin();
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);
    const invalidContext = {
      params: Promise.resolve({ companyId: 'company-1', roleId: 'not-a-uuid' }),
    };

    const patchResponse = await PATCH(
      request('PATCH', {
        expectedVersion: 1,
        name: 'Operations',
        description: null,
        permissionKeys: [],
      }, '/not-a-uuid'),
      invalidContext,
    );
    const deleteResponse = await DELETE(
      request('DELETE', undefined, '/not-a-uuid?expectedVersion=1'),
      invalidContext,
    );

    expect([patchResponse.status, deleteResponse.status]).toEqual([404, 404]);
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('performs an exact-set, versioned replacement through the RPC', async () => {
    const admin = makeAdmin({ rpc: { data: { id: 'role-1', version: 5 }, error: null } });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);
    const response = await PATCH(
      request('PATCH', {
        expectedVersion: 4,
        name: 'Operations',
        description: null,
        permissionKeys: [COMPANY_PERMISSION.ACCESS_ASSIGN],
      }, '/role-1'),
      roleContext,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: { id: 'role-1', version: 5 } });
    expect(admin.rpc).toHaveBeenCalledWith('replace_company_role', {
      p_actor_id: 'actor-1',
      p_company_id: 'company-1',
      p_role_id: ROLE_ID,
      p_expected_version: 4,
      p_name: 'Operations',
      p_description: null,
      p_permission_keys: [COMPANY_PERMISSION.ACCESS_ASSIGN],
    });
  });

  it('returns 409 for stale writes and never retries them', async () => {
    const admin = makeAdmin({
      rpc: { data: null, error: { code: 'P0001', message: 'stale_version' } },
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);
    const response = await PATCH(
      request('PATCH', {
        expectedVersion: 2,
        name: 'Operations',
        description: null,
        permissionKeys: [],
      }, '/role-1'),
      roleContext,
    );
    expect(response.status).toBe(409);
    expect(admin.rpc).toHaveBeenCalledTimes(1);
  });

  it('requires expectedVersion for archive and reports the current assignment count', async () => {
    const missing = await DELETE(request('DELETE', undefined, '/role-1'), roleContext);
    expect(missing.status).toBe(400);

    const admin = makeAdmin({
      rpc: { data: null, error: { code: 'P0001', message: 'role_assigned' } },
      tables: {
        [TABLE.COMPANY_MEMBER_ROLES]: { data: null, error: null, count: 3 },
      },
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);
    const assigned = await DELETE(
      request('DELETE', undefined, '/role-1?expectedVersion=4'),
      roleContext,
    );
    expect(assigned.status).toBe(409);
    expect(await assigned.json()).toEqual({
      error: 'Assigned roles cannot be archived',
      assignmentCount: 3,
    });
  });

  it('fails closed on an unexpected audit or database failure', async () => {
    const admin = makeAdmin({
      rpc: { data: null, error: { code: 'XX000', message: 'audit insert exploded: private detail' } },
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'actor-1', email: 'actor@bank.test' },
      admin,
    } as never);
    const response = await DELETE(
      request('DELETE', undefined, '/role-1?expectedVersion=4'),
      roleContext,
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('private detail');
  });
});
