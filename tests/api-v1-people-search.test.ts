import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

vi.mock('@/lib/dataroom/steps', () => ({
  loadDealByIdOrCode: vi.fn(),
}));

vi.mock('@/lib/api/v1/access', () => ({
  userCanAccessDeal: vi.fn(async () => true),
  userCanSearchCompanies: vi.fn(async () => true),
  userCanViewLeads: vi.fn(async () => true),
}));

import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from '@/lib/supabase/server';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { searchPeople } from '@/lib/api/v1/peopleSearch';
import { POST } from '@/app/api/v1/people/search/route';

type Resp = { data: unknown; error: unknown };

function makeAdmin(opts: { tables?: Record<string, Resp | Resp[]> }) {
  const tables = opts.tables ?? {};
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.eq = chain;
    builder.or = chain;
    builder.ilike = chain;
    builder.limit = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.then = (onFulfilled: (v: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'md-1', email: 'md@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('searchPeople', () => {
  it('merges deal members and CRM contacts for an authorized actor', async () => {
    vi.mocked(loadDealByIdOrCode).mockResolvedValue({
      id: 'deal-1',
      code: 'SUMMIT',
      codename: 'Project Summit',
    } as Awaited<ReturnType<typeof loadDealByIdOrCode>>);

    const admin = makeAdmin({
      tables: {
        users: [
          { data: { tenant_id: 'tenant-1', company_id: 'bank-1' }, error: null },
          {
            data: [
              {
                id: 'u2',
                display_name: 'Alex Chen',
                full_name: 'Alex Chen',
                email: 'alex@bank.dev',
              },
            ],
            error: null,
          },
        ],
        deal_memberships: {
          data: [
            {
              deal_role: 'md',
              user: {
                id: 'u1',
                display_name: 'Storm Duncan',
                full_name: 'Storm Duncan',
                email: 'storm@bank.dev',
              },
            },
          ],
          error: null,
        },
        deal_parties: { data: [{ company_id: 'lead-1' }], error: null },
        companies: { data: { id: 'lead-1', name: 'Atlassian' }, error: null },
        lead_relationships: {
          data: [
            {
              id: 'rel-1',
              person_name: 'Mike Cannon-Brookes',
              person_company: 'Atlassian',
              contact_info: 'mike@atlassian.com',
            },
          ],
          error: null,
        },
        lead_stakeholders: { data: [], error: null },
        crm_people: { data: [], error: null },
      },
    });

    const people = await searchPeople(admin, 'md-1', {
      query: 'mike',
      dealId: 'deal-1',
      companyId: 'lead-1',
    });

    expect(people.some((p) => p.name === 'Mike Cannon-Brookes' && p.email === 'mike@atlassian.com')).toBe(
      true,
    );
  });

  it('excludes target stakeholders when scope is firm_network', async () => {
    const admin = makeAdmin({
      tables: {
        users: [
          { data: { tenant_id: 'tenant-1', company_id: 'bank-1' }, error: null },
          { data: [], error: null },
        ],
        companies: { data: { id: 'lead-1', name: 'Atlassian' }, error: null },
        lead_relationships: { data: [], error: null },
        lead_stakeholders: {
          data: [{ id: 'stk-1', name: 'Scott Farquhar', org: 'Atlassian' }],
          error: null,
        },
        crm_people: {
          data: [{ id: 'p1', name: 'Alex Chen', email: 'alex@bank.dev', org: null }],
          error: null,
        },
      },
    });

    const all = await searchPeople(admin, 'md-1', {
      query: 'sc',
      companyId: 'lead-1',
    });
    const firmOnly = await searchPeople(admin, 'md-1', {
      query: 'sc',
      companyId: 'lead-1',
      scope: 'firm_network',
    });

    expect(all.some((person) => person.name === 'Scott Farquhar')).toBe(true);
    expect(firmOnly.some((person) => person.name === 'Scott Farquhar')).toBe(false);
  });

  it('returns empty for short queries', async () => {
    const admin = makeAdmin({});
    expect(await searchPeople(admin, 'md-1', { query: 'a' })).toEqual([]);
  });

  it('lists company employees when scope is company_employees', async () => {
    const admin = makeAdmin({
      tables: {
        users: [
          { data: { tenant_id: 'tenant-1', company_id: 'cust-1' }, error: null },
          {
            data: [
              {
                id: 'u1',
                display_name: 'Jamie Rivera',
                full_name: 'Jamie Rivera',
                email: 'jamie@tokmail.dev',
              },
            ],
            error: null,
          },
        ],
        companies: { data: { id: 'cust-1', name: 'Tokmail' }, error: null },
      },
    });

    const people = await searchPeople(admin, 'md-1', {
      query: '',
      scope: 'company_employees',
    });

    expect(people).toEqual([
      expect.objectContaining({ name: 'Jamie Rivera', source: 'company_user' }),
    ]);
  });
});

function postRequest(body: unknown, raw = false) {
  return new Request('http://localhost/api/v1/people/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe('POST /api/v1/people/search', () => {
  it('returns suggestions from the search helper', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: { data: { tenant_id: 'tenant-1', company_id: null }, error: null },
        },
      }),
    );

    const res = await POST(postRequest({ query: 'al' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people).toEqual([]);
  });

  it('reads the query, deal, company and scope from the body, not the URL', async () => {
    signedIn(
      makeAdmin({
        tables: {
          users: [
            { data: { status: 'active' }, error: null }, // requireApiUser onboarding probe
            { data: { tenant_id: 'tenant-1', company_id: 'cust-1' }, error: null },
            {
              data: [
                {
                  id: 'u1',
                  display_name: 'Jamie Rivera',
                  full_name: 'Jamie Rivera',
                  email: 'jamie@tokmail.dev',
                },
              ],
              error: null,
            },
          ],
          companies: { data: { id: 'cust-1', name: 'Tokmail' }, error: null },
        },
      }),
    );

    const res = await POST(postRequest({ scope: 'company_employees' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people).toEqual([
      expect.objectContaining({ name: 'Jamie Rivera', source: 'company_user' }),
    ]);
  });

  it('returns an empty list for an empty query outside company_employees', async () => {
    signedIn(makeAdmin({}));
    const res = await POST(postRequest({ query: '   ', scope: 'firm_network' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ people: [] });
  });

  it('returns 400 for an invalid JSON body', async () => {
    signedIn(makeAdmin({}));
    const res = await POST(postRequest('{not json', true));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('treats non-string fields as absent rather than throwing', async () => {
    signedIn(makeAdmin({}));
    const res = await POST(postRequest({ query: 42, dealId: {}, scope: ['all'] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ people: [] });
  });

  it('returns 401 when not signed in', async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
    const res = await POST(postRequest({ query: 'al' }));
    expect(res.status).toBe(401);
  });
});
