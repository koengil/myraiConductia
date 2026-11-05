import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET as companiesGET } from '@/app/api/v1/companies/route';
import {
  GET as membersGET,
  POST as membersPOST,
} from '@/app/api/v1/companies/[companyId]/members/route';
import { GET as notificationsGET } from '@/app/api/v1/notifications/route';
import { PATCH as notificationPATCH } from '@/app/api/v1/notifications/[notificationId]/route';

type Resp = { data: unknown; error: unknown };

/**
 * Chainable admin stub. Every query-builder method returns the builder; the
 * builder is thenable and its terminals resolve the per-table response. A table
 * may hold a QUEUE of responses (shifted per `from()` call) so a handler that
 * queries the same table twice — e.g. an access check then a roster read — can
 * return different rows each time.
 */
function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const queryCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = vi.fn((table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      queryCalls.push({ table, method, args });
      return builder;
    };
    for (const k of ['select', 'eq', 'is', 'or', 'ilike', 'not', 'update', 'order', 'limit', 'insert']) {
      builder[k] = chain(k);
    }
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (onFulfilled: (v: Resp) => unknown) => Promise.resolve(resp).then(onFulfilled);
    return builder;
  });
  return { from, queryCalls } as unknown as ReturnType<typeof createSupabaseAdminClient> & {
    queryCalls: Array<{ table: string; method: string; args: unknown[] }>;
  };
}

function signedIn(admin: ReturnType<typeof makeAdmin>, user = { id: 'u-1', email: 'u@bank.dev' }) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

function anon() {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/companies', () => {
  it('401 when not signed in', async () => {
    anon();
    const res = await companiesGET(new Request('http://localhost/api/v1/companies?type=target'));
    expect(res.status).toBe(401);
  });

  it('returns tenant companies for an internal (non-walled) caller', async () => {
    signedIn(
      makeAdmin({
        users: [
          { data: { status: 'active' }, error: null }, // requireApiUser onboarding probe
          { data: { firm_role: null, department: 'ib', is_external: false }, error: null }, // search gate
          { data: { tenant_id: 't-1' }, error: null }, // tenant lookup
        ],
        companies: { data: [{ id: 'c1', name: 'Canva', type: 'target' }], error: null },
      }),
    );
    const res = await companiesGET(
      new Request('http://localhost/api/v1/companies?type=target'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { companies: Array<{ name: string }> };
    expect(body.companies[0].name).toBe('Canva');
  });

  it('403 for an external caller (must not enumerate the pipeline)', async () => {
    signedIn(
      makeAdmin({
        users: { data: { firm_role: null, department: null, is_external: true }, error: null },
      }),
    );
    const res = await companiesGET(new Request('http://localhost/api/v1/companies'));
    expect(res.status).toBe(403);
  });

  it('403 for a walled research/trading caller', async () => {
    signedIn(
      makeAdmin({
        users: { data: { firm_role: null, department: 'research', is_external: false }, error: null },
      }),
    );
    const res = await companiesGET(new Request('http://localhost/api/v1/companies?type=target'));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/companies/{companyId}/members', () => {
  const ctx = (companyId: string) => ({ params: Promise.resolve({ companyId }) });

  it('403 when the caller cannot view the company', async () => {
    signedIn(
      makeAdmin({
        users: { data: { firm_role: null, company_id: 'other-co' }, error: null },
      }),
    );
    const res = await membersGET(new Request('http://localhost'), ctx('bank-1'));
    expect(res.status).toBe(403);
  });

  it('returns the roster for a company member', async () => {
    signedIn(
      makeAdmin({
        users: [
          { data: { status: 'active' }, error: null }, // requireApiUser onboarding probe
          { data: { firm_role: null, company_id: 'bank-1' }, error: null }, // access check
          { data: [{ id: 'm1', full_name: 'James Watt', department: 'ib', company_role: 'member' }], error: null }, // roster
        ],
        companies: { data: { type: 'bank' }, error: null },
      }),
    );
    const res = await membersGET(new Request('http://localhost'), ctx('bank-1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ full_name: string }> };
    expect(body.members[0].full_name).toBe('James Watt');
    expect(body.members[0]).toHaveProperty('is_walled', false);
  });

  it('includes external seats for a client company roster', async () => {
    signedIn(
      makeAdmin({
        users: [
          { data: { status: 'active' }, error: null },
          {
            data: {
              firm_role: null,
              company_id: 'client-1',
              company_role: 'director',
            },
            error: null,
          },
          {
            data: [
              {
                id: 'm1',
                full_name: 'Playboot Admin',
                email: 'admin@playboot.com',
                department: null,
                company_role: 'director',
              },
            ],
            error: null,
          },
        ],
        companies: { data: { type: 'client' }, error: null },
      }),
    );
    const res = await membersGET(new Request('http://localhost'), ctx('client-1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ email: string }> };
    expect(body.members[0].email).toBe('admin@playboot.com');
  });

  it('grants a firm overseer (cco) without company membership', async () => {
    signedIn(
      makeAdmin({
        users: [
          { data: { status: 'active' }, error: null }, // requireApiUser onboarding probe
          { data: { firm_role: 'cco', company_id: null, tenant_id: 't-1' }, error: null },
          { data: [], error: null },
        ],
        companies: [
          { data: { tenant_id: 't-1' }, error: null },
          { data: { type: 'bank' }, error: null },
        ],
      }),
    );
    const res = await membersGET(new Request('http://localhost'), ctx('bank-1'));
    expect(res.status).toBe(200);
  });

  it('includes walled rows only for a managing viewer that opts in', async () => {
    const admin = makeAdmin({
      users: [
        { data: { status: 'active' }, error: null },
        { data: { firm_role: null, company_id: 'bank-1' }, error: null },
        {
          data: {
            firm_role: null,
            company_id: 'bank-1',
            company_role: 'director',
            tenant_id: 't-1',
          },
          error: null,
        },
        {
          data: [
            {
              id: 'm1',
              full_name: 'Ren Ito',
              department: 'research',
              preferred_deal_role: null,
            },
          ],
          error: null,
        },
      ],
      companies: { data: { type: 'bank' }, error: null },
    });
    signedIn(admin);
    const res = await membersGET(
      new Request('http://localhost/api/v1/companies/bank-1/members?includeWalled=true'),
      ctx('bank-1'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: Array<{ is_walled: boolean }> };
    expect(body.members).toEqual([expect.objectContaining({ is_walled: true })]);
    expect(admin.queryCalls.some((call) => call.method === 'or')).toBe(false);
  });

  it('ignores includeWalled for a non-managing viewer', async () => {
    const admin = makeAdmin({
      users: [
        { data: { status: 'active' }, error: null },
        { data: { firm_role: null, company_id: 'bank-1' }, error: null },
        {
          data: {
            firm_role: null,
            company_id: 'bank-1',
            company_role: 'member',
            tenant_id: 't-1',
          },
          error: null,
        },
        {
          data: [
            {
              id: 'm1',
              full_name: 'Alex Reyes',
              department: 'ib',
              preferred_deal_role: 'legal',
            },
          ],
          error: null,
        },
      ],
      companies: { data: { type: 'bank' }, error: null },
    });
    signedIn(admin);
    const res = await membersGET(
      new Request('http://localhost/api/v1/companies/bank-1/members?includeWalled=true'),
      ctx('bank-1'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      members: Array<{ preferred_deal_role: string | null; is_walled: boolean }>;
    };
    expect(body.members[0]).toMatchObject({ preferred_deal_role: 'legal', is_walled: false });
    expect(admin.queryCalls.some((call) => call.method === 'or')).toBe(true);
  });

  it('rejects promoting a walled user to director', async () => {
    const admin = makeAdmin({
      companies: { data: { tenant_id: 't-1' }, error: null },
      users: [
        { data: { status: 'active' }, error: null },
        {
          data: {
            firm_role: null,
            company_id: 'bank-1',
            company_role: 'director',
            tenant_id: 't-1',
          },
          error: null,
        },
        {
          data: {
            id: 'm2',
            company_id: 'bank-1',
            department: 'trading',
            tenant_id: 't-1',
          },
          error: null,
        },
      ],
    });
    signedIn(admin);
    const res = await membersPOST(
      new Request('http://localhost/api/v1/companies/bank-1/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'trader@bank.dev', companyRole: 'director' }),
      }),
      ctx('bank-1'),
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/notifications', () => {
  it('401 when not signed in', async () => {
    anon();
    const res = await notificationsGET(new Request('http://localhost/api/v1/notifications'));
    expect(res.status).toBe(401);
  });

  it('returns the caller notifications', async () => {
    signedIn(
      makeAdmin({
        notifications: {
          data: [{ id: 'n1', event_type: 'deal_created', read_at: null }],
          error: null,
        },
      }),
    );
    const res = await notificationsGET(new Request('http://localhost/api/v1/notifications?unread=1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: Array<{ id: string }> };
    expect(body.notifications[0].id).toBe('n1');
  });
});

describe('PATCH /api/v1/notifications/{id}', () => {
  const ctx = (notificationId: string) => ({ params: Promise.resolve({ notificationId }) });

  it('404 when the notification is not the caller\'s', async () => {
    signedIn(makeAdmin({ notifications: { data: null, error: null } }));
    const res = await notificationPATCH(
      new Request('http://localhost', { method: 'PATCH', body: '{}' }),
      ctx('n-x'),
    );
    expect(res.status).toBe(404);
  });

  it('marks a notification read', async () => {
    signedIn(
      makeAdmin({
        notifications: { data: { id: 'n1', read_at: '2026-07-15T00:00:00Z' }, error: null },
      }),
    );
    const res = await notificationPATCH(
      new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ read: true }) }),
      ctx('n1'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notification: { read_at: string | null } };
    expect(body.notification.read_at).not.toBeNull();
  });
});
