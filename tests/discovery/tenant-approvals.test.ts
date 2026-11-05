import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TENANT_CAPABILITY, TENANT_CAPABILITIES } from '@/lib/constants/discovery';
import { loadTenantApprovals } from '@/lib/discovery/tenantApprovals';

// G-01 (#173), slice 2: the worker-side read of discovery_tenant_approvals. It asks for one capability's live rows in
// one tenant and answers firm company ids; any failure is "none", which is off. The fake is a chainable query builder
// over an in-memory table, so the filters the reader sends decide what comes back.

type Row = { tenant_id: string; firm_company_id: string; capability: string; revoked_at: string | null };

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const FIRM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FIRM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fakeDb(rows: Row[], failure?: { error?: { code: string } | null; throws?: boolean; data?: unknown }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const filters: Array<(row: Row) => boolean> = [];
  const builder: Record<string, unknown> = {};
  builder.select = (...args: unknown[]) => (calls.push(['select', ...args]), builder);
  builder.eq = (column: keyof Row, value: unknown) => {
    calls.push(['eq', column, value]);
    filters.push((row) => row[column] === value);
    return builder;
  };
  builder.is = (column: keyof Row, value: unknown) => {
    calls.push(['is', column, value]);
    filters.push((row) => row[column] === value);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    if (failure?.throws) return Promise.reject(new Error('network')).then(resolve, reject);
    if (failure?.error) return Promise.resolve({ data: null, error: failure.error }).then(resolve, reject);
    if (failure && 'data' in failure) return Promise.resolve({ data: failure.data, error: null }).then(resolve, reject);
    const data = rows.filter((row) => filters.every((keep) => keep(row))).map((row) => ({ firm_company_id: row.firm_company_id }));
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  };
  return { db: { from: (table: string) => (calls.push(['from', table]), builder) } as never, calls };
}

const row = (firm: string, capability: string, over: Partial<Row> = {}): Row => ({
  tenant_id: TENANT,
  firm_company_id: firm,
  capability,
  revoked_at: null,
  ...over,
});

describe('loadTenantApprovals', () => {
  it('names the three capabilities the SQL CHECK allows', () => {
    expect(TENANT_CAPABILITIES).toEqual(['team_proposals', 'milestone_rules', 'firm_name_alias']);
    expect(TENANT_CAPABILITY.TEAM_PROPOSALS).toBe('team_proposals');
  });

  it('reads the approvals table for the tenant and the asked capability, live rows only', async () => {
    const { db, calls } = fakeDb([row(FIRM_A, 'team_proposals')]);
    await loadTenantApprovals(db, TENANT, TENANT_CAPABILITY.TEAM_PROPOSALS);
    expect(calls).toEqual([
      ['from', 'discovery_tenant_approvals'],
      ['select', 'firm_company_id'],
      ['eq', 'tenant_id', TENANT],
      ['eq', 'capability', 'team_proposals'],
      ['is', 'revoked_at', null],
    ]);
  });

  it('returns the live firms for the asked capability only', async () => {
    const rows = [
      row(FIRM_A, 'team_proposals'),
      row(FIRM_B, 'milestone_rules'),
      row(FIRM_B, 'team_proposals', { revoked_at: '2026-10-22T10:00:00Z' }),
      row(FIRM_B, 'firm_name_alias', { tenant_id: OTHER_TENANT }),
    ];
    expect(await loadTenantApprovals(fakeDb(rows).db, TENANT, TENANT_CAPABILITY.TEAM_PROPOSALS)).toEqual([FIRM_A]);
    expect(await loadTenantApprovals(fakeDb(rows).db, TENANT, TENANT_CAPABILITY.MILESTONE_RULES)).toEqual([FIRM_B]);
    expect(await loadTenantApprovals(fakeDb(rows).db, TENANT, TENANT_CAPABILITY.FIRM_NAME_ALIAS)).toEqual([]);
    expect(await loadTenantApprovals(fakeDb(rows).db, OTHER_TENANT, TENANT_CAPABILITY.FIRM_NAME_ALIAS)).toEqual([FIRM_B]);
  });

  it('returns nothing for a tenant with no approvals', async () => {
    expect(await loadTenantApprovals(fakeDb([]).db, TENANT, TENANT_CAPABILITY.TEAM_PROPOSALS)).toEqual([]);
  });

  it('lists a firm once', async () => {
    const rows = [row(FIRM_A, 'team_proposals'), row(FIRM_A, 'team_proposals')];
    expect(await loadTenantApprovals(fakeDb(rows).db, TENANT, TENANT_CAPABILITY.TEAM_PROPOSALS)).toEqual([FIRM_A]);
  });

  it('is off on a read error', async () => {
    const { db } = fakeDb([row(FIRM_A, 'team_proposals')], { error: { code: '42501' } });
    expect(await loadTenantApprovals(db, TENANT, TENANT_CAPABILITY.TEAM_PROPOSALS)).toEqual([]);
  });

  it('is off when the call throws', async () => {
    const { db } = fakeDb([row(FIRM_A, 'team_proposals')], { throws: true });
    expect(await loadTenantApprovals(db, TENANT, TENANT_CAPABILITY.TEAM_PROPOSALS)).toEqual([]);
  });

  it('is off on a malformed answer', async () => {
    for (const data of [null, undefined, 'x', {}, [{ firm_company_id: 7 }, { other: 'y' }, null]]) {
      const { db } = fakeDb([], { data });
      expect(await loadTenantApprovals(db, TENANT, TENANT_CAPABILITY.TEAM_PROPOSALS), JSON.stringify(data)).toEqual([]);
    }
  });
});

// supabase/tests/discovery_model_proposals.sql pins the guard against a database (SQL suite in CI); this pins its shape
// in the migration, so the checks the review asked for cannot be dropped without a failing unit test.
describe('the approvals guard (migration 20261023110100)', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261023110100_discovery_tenant_approvals.sql'), 'utf8')
    .replace(/--[^\n]*/g, '');
  const start = sql.search(/create\s+or\s+replace\s+function\s+discovery_tenant_approvals_guard\s*\(/i);
  const body = sql.slice(start, sql.indexOf('$$;', start));
  const insertBranch = body.slice(body.search(/if\s+tg_op\s*=\s*'INSERT'/i), body.search(/the key columns are frozen/i));

  it('ties an inserted approval to a bank company of its own tenant (review F3)', () => {
    expect(insertBranch).toMatch(/from\s+companies\s+c/i);
    expect(insertBranch).toMatch(/c\.id\s*=\s*new\.firm_company_id/i);
    expect(insertBranch).toMatch(/c\.tenant_id\s*=\s*new\.tenant_id/i);
    expect(insertBranch).toMatch(/c\.type\s*=\s*'bank'/i);
  });

  it('stamps an inserted approval with the statement time, never a chosen one (review F4)', () => {
    expect(insertBranch).toMatch(/new\.approved_at\s*:=\s*now\(\)/i);
  });
});
