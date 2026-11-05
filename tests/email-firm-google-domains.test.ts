import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { boundGoogleSubject, firmGoogleDomains } from '../src/lib/email/firmGoogleDomains';

/*
 * Who a Google account must be to send as a banker (#490 R19, T14). Contracts:
 *   1. The company's google firm_identity_providers row wins, alone, lowercased.
 *   2. Otherwise the company's verified domains, lowercased and deduplicated.
 *   3. No company, or neither source -> empty.
 *   4. A read error throws; it never reads as "no domain" or "no binding".
 *   5. The bound Google sub comes from work_identity_bindings (provider google).
 *   6. Every call is a read: nothing is written.
 */

type Resp = { data: unknown; error: unknown };
type Call = { table: string; ops: string[]; filters: Array<[string, unknown]> };

function fakeAdmin(queue: Record<string, Resp[]> = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, ops: [], filters: [] };
    calls.push(call);
    const next = () => Promise.resolve(queue[table]?.shift() ?? { data: null, error: null });
    const b: Record<string, unknown> = {};
    for (const op of ['select', 'insert', 'upsert', 'update', 'delete']) {
      b[op] = () => {
        call.ops.push(op);
        return b;
      };
    }
    b.eq = (column: string, value: unknown) => {
      call.filters.push([column, value]);
      return b;
    };
    b.maybeSingle = next;
    b.then = (f: (v: Resp) => unknown, r?: (e: unknown) => unknown) => next().then(f, r);
    return b;
  };
  return { admin: { from } as unknown as SupabaseClient, calls };
}

const readOnly = (calls: Call[]) => calls.every((c) => c.ops.every((op) => op === 'select'));

describe('firmGoogleDomains', () => {
  it('uses the google identity-provider row alone when it exists', async () => {
    const { admin, calls } = fakeAdmin({
      firm_identity_providers: [{ data: { organization_id: ' Ignatious.COM ' }, error: null }],
      company_verified_domains: [{ data: [{ domain: 'other.com' }], error: null }],
    });
    expect(await firmGoogleDomains(admin, 'co-1')).toEqual(['ignatious.com']);
    expect(calls.map((c) => c.table)).toEqual(['firm_identity_providers']);
    expect(calls[0].filters).toEqual([
      ['company_id', 'co-1'],
      ['provider', 'google'],
    ]);
    expect(readOnly(calls)).toBe(true);
  });

  it('falls back to the verified domains, lowercased and deduplicated', async () => {
    const { admin, calls } = fakeAdmin({
      firm_identity_providers: [{ data: null, error: null }],
      company_verified_domains: [{ data: [{ domain: 'ignatious.com' }, { domain: 'Ignatious.com' }, { domain: 'ignatious.co.uk' }], error: null }],
    });
    expect(await firmGoogleDomains(admin, 'co-1')).toEqual(['ignatious.com', 'ignatious.co.uk']);
    expect(calls[1]).toMatchObject({ table: 'company_verified_domains', filters: [['company_id', 'co-1']] });
    expect(readOnly(calls)).toBe(true);
  });

  it('is empty with no company, and with neither source', async () => {
    const none = fakeAdmin();
    expect(await firmGoogleDomains(none.admin, null)).toEqual([]);
    expect(none.calls).toHaveLength(0);
    const empty = fakeAdmin({ company_verified_domains: [{ data: [], error: null }] });
    expect(await firmGoogleDomains(empty.admin, 'co-1')).toEqual([]);
  });

  it('throws on a read error of either source', async () => {
    const idp = fakeAdmin({ firm_identity_providers: [{ data: null, error: { code: '57014', message: 'x' } }] });
    await expect(firmGoogleDomains(idp.admin, 'co-1')).rejects.toThrow();
    const domains = fakeAdmin({ company_verified_domains: [{ data: null, error: { code: '57014', message: 'x' } }] });
    await expect(firmGoogleDomains(domains.admin, 'co-1')).rejects.toThrow();
  });
});

describe('boundGoogleSubject', () => {
  it("reads the user's google binding", async () => {
    const { admin, calls } = fakeAdmin({ work_identity_bindings: [{ data: { provider_subject: 'google-sub-1' }, error: null }] });
    expect(await boundGoogleSubject(admin, 'u-1')).toBe('google-sub-1');
    expect(calls[0].filters).toEqual([
      ['user_id', 'u-1'],
      ['provider', 'google'],
    ]);
    expect(readOnly(calls)).toBe(true);
  });

  it('is undefined without a binding, and throws on a read error', async () => {
    expect(await boundGoogleSubject(fakeAdmin().admin, 'u-1')).toBeUndefined();
    const broken = fakeAdmin({ work_identity_bindings: [{ data: null, error: { code: '57014', message: 'x' } }] });
    await expect(boundGoogleSubject(broken.admin, 'u-1')).rejects.toThrow();
  });
});
