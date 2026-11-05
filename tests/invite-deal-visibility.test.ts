import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  canManageDealMembersChecked,
  userCanAccessDeal,
  userCanInviteChecked,
  userCanManageInvite,
} from '@/lib/api/v1/access';
import { inviteDealHidden } from '@/lib/api/v1/dealNotVisible';

/*
 * The invite family's visibility gate (decision-log D65, #245) widens "can
 * see the deal" by exactly the family's own deal-scoped invite authority, and
 * by nothing else. This suite runs the real predicates over one fake world and
 * every caller shape, and requires:
 *
 *   gate passes  <=>  userCanAccessDeal
 *                     || userCanInviteChecked (onto the caller's own company)
 *                     || canManageDealMembersChecked
 *                     || userCanManageInvite for an invite this deal can carry
 *
 * A tier added to one predicate and not reflected in the gate (or the other
 * way round) fails here, naming the caller.
 */

const TENANT = '77777777-7777-4777-8777-777777777777';
const OTHER_TENANT = '74747474-7474-4747-8747-747474747474';
const DEAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const BANK_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_BANK = '56565656-5656-4565-8565-565656565656';
const PARTY_COMPANY = '44444444-4444-4444-8444-444444444444';
const NON_PARTY_COMPANY = '43434343-4343-4343-8343-434343434343';

type Row = Record<string, unknown>;
type Seat = { deal_role: string; access_scope: Row } | null;
type Fixture = { profile: Row; seat: Seat; expected: 'pass' | 'hidden' };

const internal = (over: Row = {}): Row => ({
  firm_role: null,
  tenant_id: TENANT,
  is_external: false,
  company_id: OTHER_BANK,
  company_role: null,
  ...over,
});
const external = (over: Row = {}): Row => internal({ is_external: true, ...over });
const seat = (dealRole: string, scope: Row = {}): Seat => ({ deal_role: dealRole, access_scope: scope });

/** Every caller shape the invite family distinguishes, with the gate's intended verdict. */
const FIXTURES: Record<string, Fixture> = {
  'seated deal-team member': { profile: internal(), seat: seat('deal_team'), expected: 'pass' },
  'deal MD': { profile: internal(), seat: seat('md'), expected: 'pass' },
  'delegated member manager': {
    profile: internal(),
    seat: seat('deal_team', { can_manage_members: true }),
    expected: 'pass',
  },
  'seated external member': {
    profile: external({ company_id: PARTY_COMPANY, company_role: 'member' }),
    seat: seat('seller'),
    expected: 'pass',
  },
  'party company director, no seat': {
    profile: external({ company_id: PARTY_COMPANY, company_role: 'director' }),
    seat: null,
    expected: 'pass',
  },
  'owning bank director, no seat': {
    profile: internal({ company_id: BANK_ID, company_role: 'director' }),
    seat: null,
    expected: 'pass',
  },
  'same-tenant firm admin': { profile: internal({ firm_role: 'admin' }), seat: null, expected: 'pass' },
  'same-tenant CCO': { profile: internal({ firm_role: 'cco' }), seat: null, expected: 'pass' },
  'unseated banker': { profile: internal(), seat: null, expected: 'hidden' },
  'director of another bank, no seat': {
    profile: internal({ company_role: 'director' }),
    seat: null,
    expected: 'hidden',
  },
  'non-party external director': {
    profile: external({ company_id: NON_PARTY_COMPANY, company_role: 'director' }),
    seat: null,
    expected: 'hidden',
  },
  'party company member, no seat': {
    profile: external({ company_id: PARTY_COMPANY, company_role: 'member' }),
    seat: null,
    expected: 'hidden',
  },
  'external director with no company': {
    profile: external({ company_id: null, company_role: 'director' }),
    seat: null,
    expected: 'hidden',
  },
  'firm admin of another tenant': {
    profile: internal({ firm_role: 'admin', tenant_id: OTHER_TENANT }),
    seat: null,
    expected: 'hidden',
  },
  'CCO of another tenant': {
    profile: internal({ firm_role: 'cco', tenant_id: OTHER_TENANT }),
    seat: null,
    expected: 'hidden',
  },
};

const CALLER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** A filter-aware service-role stand-in. `failing` makes reads of that table error. */
function world(fixture: Fixture, failing?: string): SupabaseClient {
  const rowsFor = (table: string, filters: Row): Row[] => {
    switch (table) {
      case 'users':
        return filters.id === CALLER ? [{ id: CALLER, ...fixture.profile }] : [];
      case 'deals':
        return filters.id === DEAL_ID ? [{ id: DEAL_ID, tenant_id: TENANT, bank_id: BANK_ID }] : [];
      case 'deal_memberships':
        return fixture.seat && filters.deal_id === DEAL_ID && filters.user_id === CALLER
          ? [{ id: 'seat-1', ...fixture.seat }]
          : [];
      case 'deal_parties':
        return filters.deal_id === DEAL_ID && filters.company_id === PARTY_COMPANY
          ? [{ id: 'party-1', party_role: 'target' }]
          : [];
      case 'companies':
        return [{ id: filters.id, tenant_id: TENANT, type: 'target' }];
      default:
        return [];
    }
  };
  const from = (table: string) => {
    const filters: Row = {};
    const settle = () =>
      Promise.resolve(
        table === failing
          ? { data: null, error: { message: 'read failed' } }
          : { data: rowsFor(table, filters)[0] ?? null, error: null },
      );
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      single: settle,
      maybeSingle: settle,
    };
    return builder;
  };
  return { from } as unknown as SupabaseClient;
}

async function predicatesAdmit(admin: SupabaseClient, companyId: string | null): Promise<boolean> {
  if (await userCanAccessDeal(admin, CALLER, DEAL_ID)) return true;
  if ((await userCanInviteChecked(admin, CALLER, { companyId: companyId ?? '', dealId: DEAL_ID })) === true) {
    return true;
  }
  if ((await canManageDealMembersChecked(admin, CALLER, DEAL_ID)) === true) return true;
  // An invite on this deal is for one of its parties or for the owning bank.
  for (const inviteCompany of [PARTY_COMPANY, BANK_ID]) {
    if (await userCanManageInvite(admin, CALLER, { companyId: inviteCompany, dealId: DEAL_ID })) return true;
  }
  return false;
}

describe('inviteDealHidden: passes exactly the callers the invite predicates admit (D65)', () => {
  it.each(Object.entries(FIXTURES))('%s', async (_name, fixture) => {
    const admin = world(fixture);
    const companyId = (fixture.profile.company_id as string | null) ?? null;

    const gate = await inviteDealHidden(admin, { id: CALLER, companyId }, DEAL_ID);
    const admitted = await predicatesAdmit(admin, companyId);

    expect(gate === null).toBe(admitted);
    expect(gate === null ? 'pass' : 'hidden').toBe(fixture.expected);
    if (gate) {
      expect(gate.status).toBe(404);
      expect(await gate.json()).toEqual({ error: 'Deal not found' });
    }
  });
});

describe('inviteDealHidden: a failed authority read is a 503, never a pass', () => {
  it.each([
    ['the caller profile', 'users', FIXTURES['owning bank director, no seat']],
    ['the party row', 'deal_parties', FIXTURES['party company director, no seat']],
  ] as const)('when %s cannot be read', async (_what, table, fixture) => {
    const gate = await inviteDealHidden(
      world(fixture, table),
      { id: CALLER, companyId: fixture.profile.company_id as string },
      DEAL_ID,
    );

    expect(gate?.status).toBe(503);
    expect(await gate?.json()).toEqual({ error: 'Access could not be verified. Try again.' });
  });
});
