import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/http', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/v1/http')>(
    '@/lib/api/v1/http',
  );
  return { ...actual, requireApiUser: vi.fn() };
});
vi.mock('@/lib/api/v1/requireFlag', () => ({ isFlagEnabled: vi.fn() }));
vi.mock('@/lib/api/v1/companyAccess', () => ({
  getCompanyEffectivePermissionsChecked: vi.fn(),
}));

import { GET } from '@/app/api/v1/me/route';
import { getCompanyEffectivePermissionsChecked } from '@/lib/api/v1/companyAccess';
import { requireApiUser } from '@/lib/api/v1/http';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';

const profile = {
  id: 'u1',
  email: 'employee@example.test',
  full_name: 'Employee One',
  display_name: null,
  firm_role: null,
  department: 'admin',
  is_external: false,
  status: 'active',
  company_id: 'c1',
  company_role: 'member',
  can_invite: false,
};

function makeAdmin() {
  const from = vi.fn((table: string) => {
    const response =
      table === 'users'
        ? { data: profile, error: null }
        : table === 'companies'
          ? { data: { id: 'c1', name: 'Tokmail' }, error: null }
          : { data: [], error: null };
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.single = vi.fn(() => Promise.resolve(response));
    builder.maybeSingle = vi.fn(() => Promise.resolve(response));
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(response).then(resolve);
    return builder;
  });
  return { from };
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/me company access', () => {
  it('returns source-aware effective permissions when Phase B is enabled', async () => {
    const admin = makeAdmin();
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1' },
      admin,
    } as never);
    vi.mocked(isFlagEnabled).mockResolvedValue(true);
    vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValue([
      {
        permissionKey: 'company:invites:send',
        source: { type: 'role', id: 'r1', name: 'Inviter' },
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      company_permissions: [
        {
          permissionKey: 'company:invites:send',
          source: { type: 'role', id: 'r1', name: 'Inviter' },
        },
      ],
    });
    expect(getCompanyEffectivePermissionsChecked).toHaveBeenCalledWith(admin, 'u1', 'c1');
  });

  it('fails closed when effective permissions are unreadable', async () => {
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1' },
      admin: makeAdmin(),
    } as never);
    vi.mocked(isFlagEnabled).mockResolvedValue(true);
    vi.mocked(getCompanyEffectivePermissionsChecked).mockResolvedValue('unreadable');

    const response = await GET();

    expect(response.status).toBe(503);
  });

  it('does not resolve Phase B permissions while the flag is disabled', async () => {
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u1' },
      admin: makeAdmin(),
    } as never);
    vi.mocked(isFlagEnabled).mockResolvedValue(false);

    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).company_permissions).toBeUndefined();
    expect(getCompanyEffectivePermissionsChecked).not.toHaveBeenCalled();
  });
});
