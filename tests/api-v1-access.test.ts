import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/api/v1/requireFlag', () => ({
  isFlagEnabled: vi.fn(async () => false),
  requireFlag: vi.fn(async () => null),
}));
import {
  canManageCompanyMembers,
  canManageDealMembers,
  listDealsForUser,
  listMemberDealSummaries,
  userCanAccessDeal,
  userCanCreateLead,
  userCanViewLeads,
  userCanViewCompany,
  userCanViewCompanyLeadMaps,
  userIsDealMd,
} from '@/lib/api/v1/access';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { COMPANY_ROLE, DEAL_ROLE, DEPARTMENT, FIRM_ROLE } from '@/lib/constants/roles';

type Resp = { data: unknown; error: unknown };

/**
 * Minimal chainable Supabase query-builder stub. Every non-terminal method
 * (select/eq/in) returns the builder; the terminal methods (single/maybeSingle/
 * order) resolve to the response configured for the table being queried. Each
 * scenario queries a given table at most once, so one response per table is
 * sufficient and keeps the access-control logic the thing under test.
 */
function mockAdmin(responses: Record<string, Resp>): SupabaseClient {
  const from = (table: string) => {
    const resp = responses[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.eq = chain;
    builder.in = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.order = terminal;
    // Thenable: a query awaited without an explicit terminal (e.g.
    // .select().eq()) resolves to the table response.
    builder.then = (onFulfilled: (value: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

/** Like mockAdmin but shifts a response queue per table for multi-read flows. */
function mockAdminQueue(responses: Record<string, Resp | Resp[]>): SupabaseClient {
  const queues = { ...responses };
  const from = (table: string) => {
    const entry = queues[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const terminal = () => Promise.resolve(resp);
    builder.select = chain;
    builder.eq = chain;
    builder.in = chain;
    builder.single = terminal;
    builder.maybeSingle = terminal;
    builder.order = terminal;
    builder.then = (onFulfilled: (value: Resp) => unknown) =>
      Promise.resolve(resp).then(onFulfilled);
    return builder;
  };
  return { from, rpc: () => Promise.resolve({ data: false, error: null }) } as unknown as SupabaseClient;
}

describe('userCanViewCompanyLeadMaps', () => {
  const companyId = 'company-target';

  it('grants internal staff via the company-search gate', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null, department: DEPARTMENT.IB, is_external: false }, error: null },
    });
    expect(await userCanViewCompanyLeadMaps(admin, 'banker-1', companyId)).toBe(true);
  });

  it('grants an external deal member for a lead their company registered', async () => {
    const admin = mockAdminQueue({
      users: [
        { data: { firm_role: null, department: null, is_external: true }, error: null },
        { data: { company_id: 'client-co', is_external: true, department: null }, error: null },
        { data: { company_id: 'client-co', is_external: true }, error: null },
        { data: { firm_role: null, tenant_id: 't1' }, error: null },
      ],
      companies: {
        data: { id: companyId, registered_by_company_id: 'client-co' },
        error: null,
      },
      deal_parties: { data: [{ deal_id: 'deal-1' }], error: null },
      deal_memberships: { data: { id: 'm1' }, error: null },
      deals: { data: { tenant_id: 't1' }, error: null },
    });
    expect(await userCanViewCompanyLeadMaps(admin, 'external-md', companyId)).toBe(true);
  });

  it('denies an external user when the lead belongs to another company', async () => {
    const admin = mockAdminQueue({
      users: [
        { data: { firm_role: null, department: null, is_external: true }, error: null },
        { data: { company_id: 'client-co', is_external: true, department: null }, error: null },
      ],
      companies: {
        data: { id: companyId, registered_by_company_id: 'other-co' },
        error: null,
      },
    });
    expect(await userCanViewCompanyLeadMaps(admin, 'external-md', companyId)).toBe(false);
  });

  it('denies an external user for legacy bank-registered leads with no owner', async () => {
    const admin = mockAdminQueue({
      users: [
        { data: { firm_role: null, department: null, is_external: true }, error: null },
        { data: { company_id: 'client-co', is_external: true, department: null }, error: null },
      ],
      companies: { data: { id: companyId, registered_by_company_id: null }, error: null },
    });
    expect(await userCanViewCompanyLeadMaps(admin, 'external-md', companyId)).toBe(false);
  });

  it('denies a walled research analyst even when seated on the deal', async () => {
    const admin = mockAdminQueue({
      users: [
        { data: { firm_role: null, department: DEPARTMENT.RESEARCH, is_external: false }, error: null },
        { data: { company_id: null, is_external: false, department: DEPARTMENT.RESEARCH }, error: null },
      ],
    });
    expect(await userCanViewCompanyLeadMaps(admin, 'research-1', companyId)).toBe(false);
  });

  it('denies an external user who is not on a deal for that company', async () => {
    const admin = mockAdminQueue({
      users: [
        { data: { firm_role: null, department: null, is_external: true }, error: null },
        { data: { company_id: 'client-co', is_external: true, department: null }, error: null },
        { data: { company_id: 'client-co', is_external: true }, error: null },
      ],
      companies: {
        data: { id: companyId, registered_by_company_id: 'client-co' },
        error: null,
      },
      deal_parties: { data: [], error: null },
    });
    expect(await userCanViewCompanyLeadMaps(admin, 'external-1', companyId)).toBe(false);
  });
});

describe('userCanAccessDeal', () => {
  it('grants CCO firm-role without a membership (same tenant)', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.CCO, tenant_id: 't1' }, error: null },
      deals: { data: { tenant_id: 't1' }, error: null },
      deal_memberships: { data: null, error: null },
    });
    expect(await userCanAccessDeal(admin, 'u1', 'd1')).toBe(true);
  });

  it('grants admin firm-role without a membership (same tenant)', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.ADMIN, tenant_id: 't1' }, error: null },
      deals: { data: { tenant_id: 't1' }, error: null },
    });
    expect(await userCanAccessDeal(admin, 'u1', 'd1')).toBe(true);
  });

  it('DENIES a cross-tenant CCO/admin — overseer reach is tenant-wide only (#116)', async () => {
    const cco = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.CCO, tenant_id: 't1' }, error: null },
      deals: { data: { tenant_id: 't2' }, error: null },
    });
    expect(await userCanAccessDeal(cco, 'u1', 'd1')).toBe(false);

    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.ADMIN, tenant_id: 't1' }, error: null },
      deals: { data: { tenant_id: 't2' }, error: null },
    });
    expect(await userCanAccessDeal(admin, 'u1', 'd1')).toBe(false);
  });

  it('denies an overseer when the deal does not exist', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.CCO, tenant_id: 't1' }, error: null },
      deals: { data: null, error: null },
    });
    expect(await userCanAccessDeal(admin, 'u1', 'missing')).toBe(false);
  });

  it('grants a plain member with a membership row (same tenant)', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null, tenant_id: 't1' }, error: null },
      deal_memberships: { data: { id: 'm1' }, error: null },
      deals: { data: { tenant_id: 't1' }, error: null },
    });
    expect(await userCanAccessDeal(admin, 'u1', 'd1')).toBe(true);
  });

  it('DENIES a membership row when the deal is in another tenant', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null, tenant_id: 't1' }, error: null },
      deal_memberships: { data: { id: 'm1' }, error: null },
      deals: { data: { tenant_id: 't2' }, error: null },
    });
    expect(await userCanAccessDeal(admin, 'u1', 'd1')).toBe(false);
  });

  it('denies a non-member without elevated firm-role', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null }, error: null },
      deal_memberships: { data: null, error: null },
    });
    expect(await userCanAccessDeal(admin, 'u1', 'd1')).toBe(false);
  });
});

describe('userIsDealMd', () => {
  it('grants admin firm-role without a membership (same tenant)', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.ADMIN, tenant_id: 't1' }, error: null },
      deals: { data: { tenant_id: 't1' }, error: null },
    });
    expect(await userIsDealMd(admin, 'u1', 'd1')).toBe(true);
  });

  it('DENIES a cross-tenant admin — admin reach is tenant-wide only (#141)', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.ADMIN, tenant_id: 't1' }, error: null },
      deals: { data: { tenant_id: 't2' }, error: null },
    });
    expect(await userIsDealMd(admin, 'u1', 'd1')).toBe(false);
  });

  it('denies an admin when the deal does not exist', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.ADMIN, tenant_id: 't1' }, error: null },
      deals: { data: null, error: null },
    });
    expect(await userIsDealMd(admin, 'u1', 'missing')).toBe(false);
  });

  it('grants a member whose deal_role is md', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null }, error: null },
      deal_memberships: { data: { deal_role: DEAL_ROLE.MD }, error: null },
    });
    expect(await userIsDealMd(admin, 'u1', 'd1')).toBe(true);
  });

  it('denies a non-md member', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null }, error: null },
      deal_memberships: { data: { deal_role: DEAL_ROLE.DEAL_TEAM }, error: null },
    });
    expect(await userIsDealMd(admin, 'u1', 'd1')).toBe(false);
  });

  it('denies when there is no membership', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null }, error: null },
      deal_memberships: { data: null, error: null },
    });
    expect(await userIsDealMd(admin, 'u1', 'd1')).toBe(false);
  });
});

describe('listDealsForUser', () => {
  it('returns all tenant deals for a CCO', async () => {
    const deals = [{ id: 'd1' }, { id: 'd2' }];
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.CCO, tenant_id: 't1' }, error: null },
      deals: { data: deals, error: null },
    });
    const { data } = await listDealsForUser(admin, 'u1');
    expect(data).toEqual(deals);
  });

  it('returns an empty list for a member with no memberships', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null, tenant_id: 't1' }, error: null },
      deals: { data: null, error: null },
    });
    const { data, error } = await listDealsForUser(admin, 'u1');
    expect(data).toEqual([]);
    expect(error).toBeNull();
  });

  /** Records the column list of every `deals` read so the fallback is visible. */
  function mockDealListAdmin(dealResponses: Resp[]) {
    const selects: string[] = [];
    const from = (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const resp = (): Resp =>
        table === 'deals'
          ? (dealResponses.shift() ?? { data: null, error: null })
          : { data: { firm_role: FIRM_ROLE.CCO, tenant_id: 't1' }, error: null };
      builder.select = (columns: string) => {
        if (table === 'deals') selects.push(columns);
        return builder;
      };
      builder.eq = chain;
      builder.in = chain;
      builder.single = () => Promise.resolve(resp());
      builder.maybeSingle = () => Promise.resolve(resp());
      builder.order = () => Promise.resolve(resp());
      builder.then = (onFulfilled: (value: Resp) => unknown) =>
        Promise.resolve(resp()).then(onFulfilled);
      return builder;
    };
    return { admin: { from } as unknown as SupabaseClient, selects };
  }

  it('retries without the rail embed when the migration is not applied yet', async () => {
    const deals = [{ id: 'd1' }];
    const { admin, selects } = mockDealListAdmin([
      { data: null, error: { code: 'PGRST200', message: 'Could not find a relationship' } },
      { data: deals, error: null },
    ]);
    const { data, error } = await listDealsForUser(admin, 'u1');
    expect(data).toEqual(deals);
    expect(error).toBeNull();
    expect(selects).toHaveLength(2);
    expect(selects[0]).toContain('current_step:deal_steps');
    expect(selects[1]).not.toContain('current_step:deal_steps');
  });

  it('reports a transient read failure instead of dropping the rail embed', async () => {
    const { admin, selects } = mockDealListAdmin([
      { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    ]);
    const { error } = await listDealsForUser(admin, 'u1');
    expect((error as { code: string }).code).toBe('57014');
    expect(selects).toHaveLength(1);
  });

  it('scopes a plain member to their member deals through the membership join', async () => {
    const deals = [{ id: 'd1' }];
    const filters: Array<[string, unknown]> = [];
    const selects: string[] = [];
    const from = (table: string) => {
      const builder: Record<string, unknown> = {};
      const resp: Resp =
        table === 'deals'
          ? { data: deals, error: null }
          : { data: { firm_role: null, tenant_id: 't1' }, error: null };
      builder.select = (columns: string) => {
        if (table === 'deals') selects.push(columns);
        return builder;
      };
      builder.eq = (column: string, value: unknown) => {
        if (table === 'deals') filters.push([column, value]);
        return builder;
      };
      builder.in = () => {
        throw new Error('member deal lists must not send their deal ids in the URL');
      };
      builder.single = () => Promise.resolve(resp);
      builder.order = () => Promise.resolve(resp);
      return builder;
    };
    const { data } = await listDealsForUser({ from } as unknown as SupabaseClient, 'u1');
    expect(data).toEqual(deals);
    expect(selects[0]).toContain('deal_memberships!inner(user_id)');
    expect(filters).toEqual([['deal_memberships.user_id', 'u1']]);
  });
});

describe('listMemberDealSummaries', () => {
  it('scopes the external picker to the seated deals through the membership join (#160)', async () => {
    const deals = [{ id: 'd1', code: 'C1', codename: 'Alpha', status: 'active' }];
    const tables: string[] = [];
    const filters: Array<[string, unknown]> = [];
    const selects: string[] = [];
    const orders: Array<[string, unknown]> = [];
    const from = (table: string) => {
      tables.push(table);
      const builder: Record<string, unknown> = {};
      builder.select = (columns: string) => {
        selects.push(columns);
        return builder;
      };
      builder.eq = (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      };
      builder.in = () => {
        throw new Error('member deal lists must not send their deal ids in the URL');
      };
      builder.order = (column: string, options: unknown) => {
        orders.push([column, options]);
        return Promise.resolve({ data: deals, error: null });
      };
      return builder;
    };
    const { data, error } = await listMemberDealSummaries({ from } as unknown as SupabaseClient, 'u1');
    expect(error).toBeNull();
    expect(data).toEqual(deals);
    expect(tables).toEqual(['deals']);
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain('deal_memberships!inner(user_id)');
    expect(filters).toEqual([['deal_memberships.user_id', 'u1']]);
    expect(orders).toEqual([['created_at', { ascending: false }]]);
  });
});

describe('canManageCompanyMembers', () => {
  it('grants a firm admin for any company in their own tenant', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: FIRM_ROLE.ADMIN, company_id: 'cX', company_role: null, tenant_id: 't1' },
        error: null,
      },
      companies: { data: { tenant_id: 't1' }, error: null },
    });
    expect(await canManageCompanyMembers(admin, 'actor', 'c1')).toBe(true);
  });

  it('DENIES a cross-tenant admin — admin reach is tenant-wide only (#116/#141 family)', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: FIRM_ROLE.ADMIN, company_id: 'cX', company_role: null, tenant_id: 't1' },
        error: null,
      },
      companies: { data: { tenant_id: 't2' }, error: null },
    });
    expect(await canManageCompanyMembers(admin, 'actor', 'c1')).toBe(false);
  });

  it('denies an admin when the company does not exist', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: FIRM_ROLE.ADMIN, company_id: 'cX', company_role: null, tenant_id: 't1' },
        error: null,
      },
      companies: { data: null, error: null },
    });
    expect(await canManageCompanyMembers(admin, 'actor', 'missing')).toBe(false);
  });

  it('grants a director of the same company', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: null, company_id: 'c1', company_role: COMPANY_ROLE.DIRECTOR },
        error: null,
      },
    });
    expect(await canManageCompanyMembers(admin, 'actor', 'c1')).toBe(true);
  });

  it('denies a director of a different company', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: null, company_id: 'c2', company_role: COMPANY_ROLE.DIRECTOR },
        error: null,
      },
    });
    expect(await canManageCompanyMembers(admin, 'actor', 'c1')).toBe(false);
  });

  it('denies a plain member', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: null, company_id: 'c1', company_role: COMPANY_ROLE.MEMBER },
        error: null,
      },
    });
    expect(await canManageCompanyMembers(admin, 'actor', 'c1')).toBe(false);
  });

  it('denies when the actor has no profile', async () => {
    const admin = mockAdmin({ users: { data: null, error: null } });
    expect(await canManageCompanyMembers(admin, 'actor', 'c1')).toBe(false);
  });
});

describe('userCanViewCompany', () => {
  it('grants same-tenant CCO and firm-admin oversight', async () => {
    for (const firmRole of [FIRM_ROLE.CCO, FIRM_ROLE.ADMIN]) {
      const admin = mockAdmin({
        users: {
          data: { firm_role: firmRole, company_id: 'other-company', tenant_id: 't1' },
          error: null,
        },
        companies: { data: { tenant_id: 't1' }, error: null },
      });
      expect(await userCanViewCompany(admin, 'actor', 'company-1')).toBe(true);
    }
  });

  it('DENIES cross-tenant CCO and firm-admin oversight', async () => {
    for (const firmRole of [FIRM_ROLE.CCO, FIRM_ROLE.ADMIN]) {
      const admin = mockAdmin({
        users: {
          data: { firm_role: firmRole, company_id: 'other-company', tenant_id: 't1' },
          error: null,
        },
        companies: { data: { tenant_id: 't2' }, error: null },
      });
      expect(await userCanViewCompany(admin, 'actor', 'company-1')).toBe(false);
    }
  });

  it('denies overseer visibility when the company does not exist', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: FIRM_ROLE.CCO, company_id: 'other-company', tenant_id: 't1' },
        error: null,
      },
      companies: { data: null, error: null },
    });
    expect(await userCanViewCompany(admin, 'actor', 'missing')).toBe(false);
  });

  it('fails closed when overseer tenant scope is unreadable', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: FIRM_ROLE.ADMIN, company_id: 'other-company', tenant_id: 't1' },
        error: null,
      },
      companies: { data: { tenant_id: 't1' }, error: { message: 'failed' } },
    });
    expect(await userCanViewCompany(admin, 'actor', 'company-1')).toBe(false);
  });

  it('preserves same-company member and director visibility', async () => {
    for (const companyRole of [COMPANY_ROLE.MEMBER, COMPANY_ROLE.DIRECTOR]) {
      const admin = mockAdmin({
        users: {
          data: {
            firm_role: null,
            company_id: 'company-1',
            company_role: companyRole,
            tenant_id: 't1',
          },
          error: null,
        },
      });
      expect(await userCanViewCompany(admin, 'actor', 'company-1')).toBe(true);
    }
  });

  it('denies a member of a different company', async () => {
    const admin = mockAdmin({
      users: {
        data: { firm_role: null, company_id: 'company-2', tenant_id: 't1' },
        error: null,
      },
    });
    expect(await userCanViewCompany(admin, 'actor', 'company-1')).toBe(false);
  });
});

describe('canManageDealMembers', () => {
  it('grants the deal MD', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null }, error: null },
      deal_memberships: { data: { deal_role: DEAL_ROLE.MD }, error: null },
    });
    expect(await canManageDealMembers(admin, 'actor', 'd1')).toBe(true);
  });

  it('grants a firm admin (same tenant, via userIsDealMd)', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: FIRM_ROLE.ADMIN, tenant_id: 't1' }, error: null },
      deals: { data: { tenant_id: 't1' }, error: null },
    });
    expect(await canManageDealMembers(admin, 'actor', 'd1')).toBe(true);
  });

  it('grants a director of the deal owning company', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null, company_id: 'cBank', company_role: COMPANY_ROLE.DIRECTOR }, error: null },
      deal_memberships: { data: null, error: null },
      deals: { data: { bank_id: 'cBank' }, error: null },
    });
    expect(await canManageDealMembers(admin, 'actor', 'd1')).toBe(true);
  });

  it('grants a delegate whose seat carries can_manage_members', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null }, error: null },
      deal_memberships: {
        data: { deal_role: DEAL_ROLE.DEAL_TEAM, access_scope: { can_manage_members: true } },
        error: null,
      },
    });
    expect(await canManageDealMembers(admin, 'actor', 'd1')).toBe(true);
  });

  it('denies a plain member without delegation', async () => {
    const admin = mockAdmin({
      users: { data: { firm_role: null }, error: null },
      deal_memberships: { data: { deal_role: DEAL_ROLE.DEAL_TEAM, access_scope: null }, error: null },
    });
    expect(await canManageDealMembers(admin, 'actor', 'd1')).toBe(false);
  });
});

describe('lead permissions ignore company_access_management (PL-06, #198)', () => {
  const seatedMember = {
    company_id: 'co-bank',
    is_external: false,
    firm_role: null,
    company_role: COMPANY_ROLE.MEMBER,
    department: DEPARTMENT.IB,
  };
  // A missing feature_flags row resolves to "off" (flags fail closed); the
  // module mock above models exactly that. The permission check must still run.
  const withPermission = (rpcResult: Resp) =>
    ({
      ...mockAdminQueue({ users: { data: seatedMember, error: null } }),
      rpc: () => Promise.resolve(rpcResult),
    }) as unknown as SupabaseClient;

  it('refuses LEADS_CREATE to a seated member without the permission when the flag row is absent', async () => {
    expect(await isFlagEnabled('company_access_management')).toBe(false);
    const admin = withPermission({ data: false, error: null });
    expect(await userCanCreateLead(admin, 'martin')).toBe(false);
  });

  it('refuses LEADS_VIEW to a seated member without the permission when the flag row is absent', async () => {
    expect(await isFlagEnabled('company_access_management')).toBe(false);
    const admin = withPermission({ data: false, error: null });
    expect(await userCanViewLeads(admin, 'martin')).toBe(false);
  });

  it('refuses both when the permission read fails', async () => {
    const failing = { data: null, error: { message: 'boom' } };
    expect(await userCanCreateLead(withPermission(failing), 'martin')).toBe(false);
    expect(await userCanViewLeads(withPermission(failing), 'martin')).toBe(false);
  });

  it('grants a seated member who holds the permission', async () => {
    const granted = { data: true, error: null };
    expect(await userCanCreateLead(withPermission(granted), 'md-1')).toBe(true);
    expect(await userCanViewLeads(withPermission(granted), 'md-1')).toBe(true);
  });

  it('keeps the department rule for internal staff with no company seat', async () => {
    const admin = mockAdmin({
      users: { data: { ...seatedMember, company_id: null }, error: null },
    });
    expect(await userCanCreateLead(admin, 'legacy')).toBe(true);
    expect(await userCanViewLeads(admin, 'legacy')).toBe(true);
  });
});
