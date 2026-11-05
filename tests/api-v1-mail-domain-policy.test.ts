import { afterEach, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), flag: vi.fn() }));
vi.mock('@/lib/api/v1/http', async (original) => ({ ...await original<object>(), requireApiUser: mocks.auth }));
vi.mock('@/lib/flags/requireFlag', () => ({ requireFlag: mocks.flag }));
import { GET } from '@/app/api/v1/mail-domain-policy/route';
afterEach(() => vi.resetAllMocks());
function setup(options: { company?: string | null; companyTenant?: string; errorTable?: string; domains?: string[] } = {}) {
  const calls: Array<[string, string, unknown]> = [];
  const admin = { from(table: string) {
    const data = table === 'users' ? { company_id: options.company === undefined ? 'firm-1' : options.company, tenant_id: 'tenant-1' }
      : table === 'companies' ? { tenant_id: options.companyTenant ?? 'tenant-1' }
      : (options.domains ?? ['bank.example']).map((domain) => ({ domain }));
    const result = { data, error: options.errorTable === table ? { message: 'failed' } : null };
    const query = { select: () => query, eq: (key: string, value: unknown) => { calls.push([table, key, value]); return query; }, maybeSingle: () => Promise.resolve(result), then: (f: (value: typeof result) => unknown) => Promise.resolve(result).then(f) };
    return query;
  } } as unknown as SupabaseClient;
  mocks.auth.mockResolvedValue({ ok: true, user: { id: 'u-1' }, admin });
  mocks.flag.mockResolvedValue(null);
  return calls;
}
it('returns only the actor company domains, scoped by tenant, without caching', async () => {
  const calls = setup();
  const res = await GET();
  expect(await res.json()).toEqual({ verifiedDomains: ['bank.example'] });
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(calls).toContainEqual(['company_verified_domains', 'company_id', 'firm-1']);
  expect(calls).toContainEqual(['company_verified_domains', 'tenant_id', 'tenant-1']);
});
it('has no domain fallback for a sender without a company', async () => {
  const calls = setup({ company: null });
  expect(await (await GET()).json()).toEqual({ verifiedDomains: [] });
  expect(calls.some(([table]) => table === 'company_verified_domains')).toBe(false);
});
it('does not expose domains from a mismatched tenant', async () => {
  setup({ companyTenant: 'tenant-2' });
  expect((await GET()).status).toBe(500);
});
it.each(['users', 'companies', 'company_verified_domains'])('reports %s lookup errors', async (errorTable) => {
  setup({ errorTable }); expect((await GET()).status).toBe(500);
});
it('preserves unauthenticated and disabled-channel gates', async () => {
  setup(); mocks.auth.mockResolvedValue({ ok: false, response: NextResponse.json({}, {status:401}) });
  expect((await GET()).status).toBe(401);
  mocks.flag.mockResolvedValue(NextResponse.json({}, {status:404}));
  expect((await GET()).status).toBe(404);
});
