import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireApiUser, firmMailAccess } = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  firmMailAccess: vi.fn(),
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser,
}));
vi.mock('@/lib/api/v1/access', () => ({ firmMailAccess }));

import { GET, PUT } from '@/app/api/v1/ai-budget/route';

/*
 * /api/v1/ai-budget (D83): the firm's monthly AI budget per banker. Read by
 * the AI Costs page's readers (CCO, admin, bank director); set by a CCO or
 * admin only, and every change audited.
 */

type Call = { table: string; op: string; args: unknown[] };

function admin(opts: { companyRole?: string | null; budget?: number | null; auditFails?: boolean } = {}) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const resp =
        table === 'users'
          ? { data: { company_role: opts.companyRole ?? null }, error: null }
          : table === 'ai_budgets'
            ? {
                data: opts.budget == null ? null : { monthly_limit_usd: String(opts.budget), updated_at: '2026-10-09T12:00:00Z' },
                error: null,
              }
            : { data: null, error: null };
      for (const op of ['select', 'eq', 'delete', 'upsert', 'insert']) {
        builder[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return builder;
        };
      }
      builder.maybeSingle = () => Promise.resolve(resp);
      const error = table === 'audit_log' && opts.auditFails ? { message: 'audit down' } : null;
      builder.then = (f: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(f);
      return builder;
    },
  };
  return { client, calls };
}

function signedIn(
  firmRole: string | null,
  opts: { companyRole?: string | null; budget?: number | null; reach?: boolean; auditFails?: boolean } = {},
) {
  const { client, calls } = admin(opts);
  requireApiUser.mockResolvedValue({ ok: true, user: { id: 'u-1', email: 'x@bank.test' }, admin: client });
  const reach = opts.reach ?? true;
  firmMailAccess.mockResolvedValue({ ok: reach, tenantId: reach ? 'tenant-1' : null, firmRole });
  return calls;
}

const put = (body: unknown) =>
  PUT(new Request('http://x/api/v1/ai-budget', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/ai-budget', () => {
  it('gives the CCO the limit and the form', async () => {
    signedIn('cco', { budget: 250 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ monthlyLimitUsd: 250, updatedAt: '2026-10-09T12:00:00Z', canEdit: true });
  });

  it('gives a bank director the limit, read-only', async () => {
    signedIn(null, { companyRole: 'director', budget: 250 });
    expect(await (await GET()).json()).toMatchObject({ monthlyLimitUsd: 250, canEdit: false });
  });

  it('answers null when no budget is set', async () => {
    signedIn('admin');
    expect(await (await GET()).json()).toMatchObject({ monthlyLimitUsd: null, canEdit: true });
  });

  it('refuses a banker, and a walled or external user', async () => {
    signedIn(null, { companyRole: 'member' });
    expect((await GET()).status).toBe(403);
    signedIn('cco', { reach: false });
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/v1/ai-budget', () => {
  it('sets the limit in cents for the tenant and audits the change', async () => {
    const calls = signedIn('cco', { budget: 100 });
    const res = await put({ monthlyLimitUsd: 250.456 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ monthlyLimitUsd: 250.46, canEdit: true });
    const upsert = calls.find((c) => c.table === 'ai_budgets' && c.op === 'upsert');
    expect(upsert?.args[0]).toMatchObject({ tenant_id: 'tenant-1', monthly_limit_usd: 250.46, updated_by: 'u-1' });
    const audit = calls.find((c) => c.table === 'audit_log' && c.op === 'insert');
    expect(audit?.args[0]).toEqual({
      tenant_id: 'tenant-1',
      actor_id: 'u-1',
      action: 'update',
      detail: { kind: 'ai_budget', from: 100, to: 250.46 },
    });
  });

  it('removes the limit with null', async () => {
    const calls = signedIn('admin', { budget: 100 });
    expect(await (await put({ monthlyLimitUsd: null })).json()).toEqual({ monthlyLimitUsd: null, canEdit: true });
    expect(calls.some((c) => c.table === 'ai_budgets' && c.op === 'delete')).toBe(true);
    expect(calls.find((c) => c.table === 'audit_log')?.args[0]).toMatchObject({ detail: { kind: 'ai_budget', from: 100, to: null } });
  });

  it('answers 200 when the limit saved but its audit row did not, and logs the failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls = signedIn('cco', { auditFails: true });
    const res = await put({ monthlyLimitUsd: 50 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ monthlyLimitUsd: 50, canEdit: true });
    expect(calls.some((c) => c.table === 'ai_budgets' && c.op === 'upsert')).toBe(true);
    expect(logged).toHaveBeenCalledWith('[ai-budget] saved but audit write failed', 'tenant-1', expect.any(String));
    expect(JSON.stringify(logged.mock.calls)).not.toContain('audit down');
    logged.mockRestore();
  });

  it.each([[0], [-5], [1_000_000.01], ['100'], [true], [undefined]])('refuses %s', async (value) => {
    const calls = signedIn('cco');
    expect((await put({ monthlyLimitUsd: value })).status).toBe(400);
    expect(calls.some((c) => c.op === 'upsert' || c.op === 'delete')).toBe(false);
  });

  it('refuses a director: only a CCO or admin sets the budget', async () => {
    const calls = signedIn(null, { companyRole: 'director' });
    expect((await put({ monthlyLimitUsd: 100 })).status).toBe(403);
    expect(calls.some((c) => c.op === 'upsert')).toBe(false);
  });
});
