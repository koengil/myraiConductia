import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';

import { assessProposal, type Proposal } from '@/lib/api/v1/proposalFeasibility';

/**
 * The TypeScript half of the invite-authority parity pair. The SQL half is
 * tests/db/invite-authority-parity.test.ts, running the same twelve cases, plus R, X and X-nonclient (S, SD, SA are SQL-only: they
 * are about the actor's status, which this fake does not model)
 * against create_invite's in-transaction re-derivation.
 *
 * Nothing in `access.ts` is mocked here — only the database is. Mocking the
 * predicates would test this file's idea of authority rather than the product's,
 * and the whole point of a parity suite is to compare two real implementations.
 *
 * Every case asserts the RESOLVED outcome (which company role, which deal role,
 * which phase), not merely permitted-or-refused, so a build that reaches the
 * right verdict by the wrong route still fails.
 */

type Row = Record<string, unknown>;

/**
 * A small filtering fake. The real predicates chain `.eq()` several times and
 * finish with `.single()`, `.maybeSingle()` or by awaiting the builder, and
 * they query the same table with different filters, so serving canned responses
 * per table is not enough — rows have to actually be matched.
 */
function makeAdmin(tables: Record<string, Row[]>): SupabaseClient {
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    const rows = () =>
      (tables[table] ?? []).filter((row) => filters.every(([col, val]) => row[col] === val));
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push([col, vals[0]]);
        return builder;
      },
      limit: () => builder,
      single: async () => {
        const found = rows();
        return found.length === 1
          ? { data: found[0], error: null }
          : { data: null, error: { message: 'not found' } };
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (value: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows(), error: null }),
    };
    return builder;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    if (name !== 'app_has_company_permission') {
      return { data: null, error: { message: `unexpected RPC: ${name}` } };
    }
    const user = (tables.users ?? []).find((row) => row.id === args.p_user_id);
    const company = (tables.companies ?? []).find((row) => row.id === args.p_company_id);
    const permissions = Array.isArray(user?.company_permissions)
      ? user.company_permissions
      : [];
    const isRoot =
      Boolean(user && company && user.tenant_id === company.tenant_id) &&
      (user?.firm_role === 'admin' ||
        (user?.company_id === company?.id && user?.company_role === 'director'));
    const isGranted =
      user?.company_id === company?.id && permissions.includes(args.p_permission_key);
    return { data: Boolean(isRoot || isGranted), error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

const T1 = 'tenant-1';
const T2 = 'tenant-2';

const COMPANIES: Row[] = [
  { id: 'bank-1', tenant_id: T1, type: 'bank', name: 'Advisory Bank' },
  { id: 'seller-1', tenant_id: T1, type: 'target', name: 'Target Co' },
  { id: 'foreign-1', tenant_id: T2, type: 'target', name: 'Other Tenant Co' },
  { id: 'client-1', tenant_id: T1, type: 'client', name: 'Client Co' },
];

const USERS: Row[] = [
  // firm admin: authority anywhere inside the tenant, never outside it
  { id: 'admin-1', tenant_id: T1, company_id: 'bank-1', company_role: 'member', firm_role: 'admin', is_external: false, status: 'active' },
  // internal director of the bank company, no firm role
  { id: 'bankdir-1', tenant_id: T1, company_id: 'bank-1', company_role: 'director', firm_role: null, is_external: false, status: 'active' },
  // external director of the seller company
  { id: 'sellerdir-1', tenant_id: T1, company_id: 'seller-1', company_role: 'director', firm_role: null, is_external: true, status: 'active' },
  // A member granted the authoritative company invitation permission.
  { id: 'delegate-1', tenant_id: T1, company_id: 'bank-1', company_role: 'member', firm_role: null, is_external: false, status: 'active', company_permissions: ['company:invites:send'] },
  // A member who holds company:invites:send through a company ROLE (case R). The
  // fake resolver reads one permission list whatever its source; the SQL half
  // proves the role source against the real resolver.
  { id: 'rolemember-1', tenant_id: T1, company_id: 'bank-1', company_role: 'member', firm_role: null, is_external: false, status: 'active', company_permissions: ['company:invites:send'] },
  // external director of a CLIENT company (case X)
  { id: 'clientdir-1', tenant_id: T1, company_id: 'client-1', company_role: 'director', firm_role: null, is_external: true, status: 'active' },
  // plain member: no invitation authority at all
  { id: 'plain-1', tenant_id: T1, company_id: 'bank-1', company_role: 'member', firm_role: null, is_external: false, status: 'active' },
];

const DEALS: Row[] = [{ id: 'deal-1', tenant_id: T1, bank_id: 'bank-1' }];
const MEMBERSHIPS: Row[] = [
  { deal_id: 'deal-1', user_id: 'bankdir-1', deal_role: 'md', phase: 0, access_scope: null },
];
const PARTIES: Row[] = [{ deal_id: 'deal-1', company_id: 'seller-1', party_role: 'target' }];

let admin: SupabaseClient;

beforeEach(() => {
  admin = makeAdmin({
    users: USERS,
    companies: COMPANIES,
    deals: DEALS,
    deal_memberships: MEMBERSHIPS,
    deal_parties: PARTIES,
  });
});

function proposal(over: Partial<Proposal>): Proposal {
  return {
    email: 'invitee@target.dev',
    companyId: 'seller-1',
    companyRole: 'member',
    dealId: 'deal-1',
    dealRole: 'seller',
    phase: 0,
    ...over,
  };
}

describe('invite authority parity (TypeScript side)', () => {
  it('case 1: a firm admin creates a Director, and the confirmed phase survives', async () => {
    const result = await assessProposal(admin, 'admin-1', proposal({ companyRole: 'director', phase: 2 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companyRole).toBe('director');
    expect(result.dealRole).toBe('seller');
    expect(result.phase).toBe(2);
  });

  it('case 2: an internal Director of that same company creates a Director', async () => {
    const result = await assessProposal(
      admin,
      'bankdir-1',
      proposal({ companyId: 'bank-1', companyRole: 'director', dealRole: 'deal_team' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companyRole).toBe('director');
  });

  it('case 3: a Director of a DIFFERENT company may not create a Director', async () => {
    const result = await assessProposal(admin, 'bankdir-1', proposal({ companyRole: 'director' }));
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('case 4: invites:send permission may not create a Director', async () => {
    const result = await assessProposal(
      admin,
      'delegate-1',
      proposal({ companyId: 'bank-1', companyRole: 'director', dealId: null, dealRole: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('case 5: invites:send permission may create a Member on its own company', async () => {
    const result = await assessProposal(
      admin,
      'delegate-1',
      proposal({ companyId: 'bank-1', companyRole: 'member', dealId: null, dealRole: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companyRole).toBe('member');
  });

  it('case 6: an external actor is coerced to Member even when asking for Director', async () => {
    const result = await assessProposal(admin, 'sellerdir-1', proposal({ companyRole: 'director' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companyRole).toBe('member');
  });

  it('case 7: a plain member has no invitation authority', async () => {
    const result = await assessProposal(
      admin,
      'plain-1',
      proposal({ companyId: 'bank-1', dealId: null, dealRole: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('case 8: a cross-tenant company is refused even for a firm admin', async () => {
    const result = await assessProposal(admin, 'admin-1', proposal({ companyId: 'foreign-1' }));
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('case 9: a target-side company may not take a buyer seat', async () => {
    const result = await assessProposal(admin, 'admin-1', proposal({ dealRole: 'buyer' }));
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('case 10: an internal seat is pinned to phase 0 however high the request', async () => {
    const result = await assessProposal(
      admin,
      'admin-1',
      proposal({ companyId: 'bank-1', dealRole: 'deal_team', phase: 4 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.phase).toBe(0);
  });

  it('case 11: a negative phase is invalid', async () => {
    const result = await assessProposal(admin, 'admin-1', proposal({ phase: -1 }));
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('case R: a member holding invites:send through a role invites a Member into their company', async () => {
    const result = await assessProposal(
      admin,
      'rolemember-1',
      proposal({ companyId: 'bank-1', companyRole: 'member', dealId: null, dealRole: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companyRole).toBe('member');
  });

  it('case X: an external CLIENT director invites into their own company without a deal', async () => {
    const result = await assessProposal(
      admin,
      'clientdir-1',
      proposal({ companyId: 'client-1', companyRole: 'member', dealId: null, dealRole: null }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.companyRole).toBe('member');
  });

  it('case X-nonclient: an external director of a TARGET company gets no deal-less invite', async () => {
    const result = await assessProposal(
      admin,
      'sellerdir-1',
      proposal({ companyId: 'seller-1', companyRole: 'member', dealId: null, dealRole: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });
});
