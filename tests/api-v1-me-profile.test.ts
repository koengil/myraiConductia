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

import { GET, PATCH } from '@/app/api/v1/me/route';
import { requireApiUser } from '@/lib/api/v1/http';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

const provisioned = {
  id: 'u-new',
  email: 'roberto@conductia.com',
  full_name: 'roberto',
  display_name: null,
  firm_role: null,
  department: null,
  is_external: false,
  status: 'active',
  company_id: null,
  company_role: null,
  can_invite: false,
};

function makeAdmin(options?: {
  userRows?: Array<{ data: unknown; error: unknown }>;
  insertError?: { message: string } | null;
  updateError?: { code?: string; message: string } | null;
}) {
  let userReads = 0;
  const insert = vi.fn(() => Promise.resolve({ error: options?.insertError ?? null }));
  const update = vi.fn(() => {
    const builder: Record<string, unknown> = {
      eq: vi.fn(() => Promise.resolve({ error: options?.updateError ?? null })),
    };
    return builder;
  });
  const from = vi.fn((table: string) => {
    const builder: Record<string, unknown> = { insert, update };
    for (const method of ['select', 'eq']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi.fn(() => {
      const response =
        table === 'users'
          ? (options?.userRows?.[userReads++] ?? { data: provisioned, error: null })
          : { data: table === 'companies' ? null : [], error: null };
      return Promise.resolve(response);
    });
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: table === 'companies' ? null : [], error: null }).then(resolve);
    return builder;
  });
  return { from, insert, update };
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/me profile mirror', () => {
  it('provisions a users row from the auth email when the mirror is missing', async () => {
    const admin = makeAdmin({
      userRows: [
        { data: null, error: null },
        { data: provisioned, error: null },
      ],
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u-new', email: 'roberto@conductia.com' },
      admin,
    } as never);
    vi.mocked(isFlagEnabled).mockResolvedValue(false);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(admin.insert).toHaveBeenCalledWith({
      id: 'u-new',
      tenant_id: DEV_TENANT_ID,
      email: 'roberto@conductia.com',
      full_name: 'roberto',
      status: 'active',
    });
    expect(await response.json()).toMatchObject({
      user: { email: 'roberto@conductia.com', full_name: 'roberto' },
    });
  });
});

describe('PATCH /api/v1/me', () => {
  it('updates the caller name fields', async () => {
    const updated = { ...provisioned, full_name: 'Roberto Di Lillo', display_name: 'Rob' };
    const admin = makeAdmin({
      userRows: [
        { data: provisioned, error: null },
        { data: updated, error: null },
      ],
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u-new', email: 'roberto@conductia.com' },
      admin,
    } as never);
    vi.mocked(isFlagEnabled).mockResolvedValue(false);

    const response = await PATCH(
      new Request('http://localhost/api/v1/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'Roberto Di Lillo', displayName: 'Rob' }),
      }),
    );

    expect(response.status).toBe(200);
    expect(admin.update).toHaveBeenCalledWith({
      full_name: 'Roberto Di Lillo',
      display_name: 'Rob',
    });
    expect(await response.json()).toMatchObject({
      user: { full_name: 'Roberto Di Lillo', display_name: 'Rob' },
    });
  });

  it('#331 F3 canary: an update failure answers a code, never the database message that quotes the name', async () => {
    const admin = makeAdmin({
      userRows: [{ data: provisioned, error: null }],
      updateError: {
        code: '22001',
        message: 'value too long for type character varying(200): CANARY-331-F3',
      },
    });
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u-new', email: 'roberto@conductia.com' },
      admin,
    } as never);
    vi.mocked(isFlagEnabled).mockResolvedValue(false);

    const response = await PATCH(
      new Request('http://localhost/api/v1/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: 'CANARY-331-F3' }),
      }),
    );

    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain('CANARY-331-F3');
    expect(text).toContain('22001');
  });

  it('rejects an empty body', async () => {
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: true,
      user: { id: 'u-new', email: 'roberto@conductia.com' },
      admin: makeAdmin(),
    } as never);

    const response = await PATCH(
      new Request('http://localhost/api/v1/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
  });
});
