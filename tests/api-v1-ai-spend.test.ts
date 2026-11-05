import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireApiUser, firmMailAccess, userCanAccessDeal } = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  firmMailAccess: vi.fn(),
  userCanAccessDeal: vi.fn(),
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser,
}));
vi.mock('@/lib/api/v1/access', () => ({ firmMailAccess, userCanAccessDeal }));

import { GET } from '@/app/api/v1/ai-spend/route';

/*
 * GET /api/v1/ai-spend — who sees what of the firm's AI spend (#155).
 *
 * The Book shows a banker only the deals they sit on, so the firm-wide ledger
 * must not hand every internal user the code name of every deal and the spend
 * of every colleague. Firm overseers (CCO, admin) and bank directors get the
 * full breakdown; everyone else is refused, matching the AI Costs page.
 * A deal-scoped read is unchanged: whoever can open the deal sees all of it.
 */

type Row = { data: unknown; error: unknown };

const LEDGER = [
  { deal_id: 'deal-a', actor_id: 'u-1', source: 'screen', task: 'mail_screen', model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5, cost_usd: 0.01, created_at: '2026-09-20T10:00:00Z', deal: { code: 'AAA-1', codename: 'ORBIT' }, actor: { display_name: 'Ana Analyst', full_name: null, email: 'ana@bank.test' } },
  { deal_id: 'deal-b', actor_id: 'u-2', source: 'agent_run', task: 'p1-s9', model: null, input_tokens: null, output_tokens: null, cost_usd: 2.5, created_at: '2026-09-19T10:00:00Z', deal: { code: 'BBB-1', codename: 'NOVA' }, actor: { display_name: 'Dee Director', full_name: null, email: 'dee@bank.test' } },
];

function admin(profile: Record<string, unknown>) {
  const tables: Record<string, Row> = {
    users: { data: { tenant_id: 'tenant-1', ...profile }, error: null },
    deals: { data: { id: 'deal-a' }, error: null },
    ai_usage: { data: LEDGER, error: null },
  };
  return {
    from: (table: string) => {
      const resp = tables[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const k of ['select', 'eq', 'order', 'limit']) builder[k] = () => builder;
      builder.single = () => Promise.resolve(resp);
      builder.maybeSingle = () => Promise.resolve(resp);
      builder.then = (f: (v: Row) => unknown) => Promise.resolve(resp).then(f);
      return builder;
    },
  };
}

function signedIn(profile: Record<string, unknown>, firmRole: string | null, reach = true) {
  requireApiUser.mockResolvedValue({ ok: true, user: { id: 'u-1', email: 'x@bank.test' }, admin: admin(profile) });
  firmMailAccess.mockResolvedValue({ ok: reach, tenantId: reach ? 'tenant-1' : null, firmRole });
}

const firmWide = () => GET(new Request('http://x/api/v1/ai-spend'));

beforeEach(() => {
  vi.clearAllMocks();
  userCanAccessDeal.mockResolvedValue(true);
});

describe('GET /api/v1/ai-spend — firm-wide detail', () => {
  it('refuses the firm-wide read to a banker without firm oversight, like the AI Costs page', async () => {
    signedIn({ company_role: 'member' }, null);
    const res = await firmWide();
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/ORBIT|NOVA|AAA-1|BBB-1|Ana Analyst|Dee Director|ana@|dee@/);
  });

  it.each([
    ['a bank director', { company_role: 'director' }, null],
    ['the CCO', { company_role: 'member' }, 'cco'],
    ['a firm admin', { company_role: null }, 'admin'],
  ])('gives %s the full breakdown', async (_who, profile, firmRole) => {
    signedIn(profile, firmRole);
    const body = await (await firmWide()).json();
    expect(body.detail).toBe('full');
    expect(body.summary.byDeal.map((l: { label: string }) => l.label)).toEqual(expect.arrayContaining(['NOVA', 'ORBIT']));
    expect(body.summary.byPerson).toHaveLength(2);
    expect(body.recent).toHaveLength(2);
  });

  it('still refuses a walled or external user outright', async () => {
    signedIn({ company_role: 'director' }, null, false);
    expect((await firmWide()).status).toBe(403);
  });
});

describe('GET /api/v1/ai-spend?dealId — deal scope', () => {
  it('is unchanged: whoever can open the deal sees the whole breakdown', async () => {
    signedIn({ company_role: 'member' }, null);
    const res = await GET(new Request('http://x/api/v1/ai-spend?dealId=AAA-1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.detail).toBe('full');
    expect(body.summary.byPerson.length).toBeGreaterThan(0);
    expect(body.recent.length).toBeGreaterThan(0);
    expect(firmMailAccess).not.toHaveBeenCalled();
  });
});
