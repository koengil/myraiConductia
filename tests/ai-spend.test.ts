import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  createSupabaseServerClient,
  createSupabaseAdminClient,
} from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/ai-spend/route';
import { summarizeSpend, type AiUsageRow } from '@/lib/ai/spend';

/*
 * AI cost tracking (#109): the summary's four cuts, and the route's access
 * rule (a deal's spend for its members, the tenant's spend for internal users).
 */

const row = (over: Partial<AiUsageRow>): AiUsageRow => ({
  deal_id: 'd-1',
  deal_codename: 'ZZ TEST PAX',
  actor_id: 'u-md',
  actor_name: 'Marcelo Gumiero',
  source: 'screen',
  task: 'mail_screen',
  model: 'claude-sonnet-5',
  input_tokens: 1000,
  output_tokens: 100,
  cost_usd: 0.003,
  created_at: '2026-09-14T12:00:00Z',
  ...over,
});

describe('summarizeSpend', () => {
  it('separates agent runs from other unknown models without guessing a provider', () => {
    const summary = summarizeSpend([
      row({ source: 'agent_run', model: null, cost_usd: 3 }),
      row({ source: 'screen', model: null, cost_usd: null }),
    ]);
    expect(summary.byModel).toEqual([
      expect.objectContaining({ label: 'Ignatious agent run (model not reported)', calls: 1, costUsd: 3 }),
      expect.objectContaining({ label: 'Model not reported', calls: 1, pricedCalls: 0 }),
    ]);
  });
  it('buckets rows with no user actor as the discovery worker', () => {
    const s = summarizeSpend([
      row({ actor_id: null, actor_name: null, deal_id: null, source: 'discovery_extract', task: 'milestone_extract', cost_usd: 0.004 }),
      row({ actor_id: null, actor_name: null, deal_id: null, source: 'discovery_extract', task: 'milestone_extract', cost_usd: 0.002 }),
    ]);
    expect(s.byPerson).toEqual([expect.objectContaining({ key: 'discovery-worker', label: 'Discovery worker', calls: 2, costUsd: 0.006 })]);
    expect(s.byTask.map((l) => l.label)).toEqual(['Milestone extraction']);
  });
  it('totals priced rows and cuts by deal, person, task and model', () => {
    const s = summarizeSpend([
      row({}),
      row({ actor_id: 'u-2', actor_name: 'mgumiero9', cost_usd: '0.002', task: 'mail_send_screen' }),
      row({ deal_id: 'd-2', deal_codename: 'ZZ TEST ORBIT', source: 'agent_run', task: 'p1-s9', model: null, cost_usd: 0.41, input_tokens: null, output_tokens: null }),
      row({ model: 'some-future-model', cost_usd: null }),
    ]);
    expect(s.calls).toBe(4);
    expect(s.unpricedCalls).toBe(1);
    expect(s.totalCostUsd).toBe(0.415);
    expect(s.byDeal.map((l) => [l.label, l.costUsd])).toEqual([
      ['ZZ TEST ORBIT', 0.41],
      ['ZZ TEST PAX', 0.005],
    ]);
    expect(s.byPerson[0]).toMatchObject({ label: 'Marcelo Gumiero', calls: 3, pricedCalls: 2 });
    expect(s.byTask.map((l) => l.label)).toEqual(['MD Briefing + Company Backgrounding', 'Mail screen (draft)', 'Mail screen (send)']);
    expect(s.byTask[0].key).toBe('p1-s9');
    expect(s.byModel.map((l) => l.label)).toEqual(['Ignatious agent run (model not reported)', 'claude-sonnet-5', 'some-future-model']);
    expect(s.byPerson[0].inputTokens).toBe(2000);
  });
});

type Resp = { data: unknown; error: unknown };

function makeAdmin(tables: Record<string, Resp | Resp[]>) {
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = Array.isArray(entry)
      ? (entry.shift() ?? { data: null, error: null })
      : (entry ?? { data: null, error: null });
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    for (const k of ['select', 'eq', 'in', 'order', 'limit']) builder[k] = chain;
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return builder;
  };
  return { from } as unknown as ReturnType<typeof createSupabaseAdminClient>;
}

function signedIn(admin: ReturnType<typeof makeAdmin>) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'u-md', email: 'md@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/ai-spend', () => {
  it('summarizes a deal for a member and names the deal and the person', async () => {
    signedIn(
      makeAdmin({
        // requireApiUser profile, route profile, userCanAccessDeal profile (member, no firm role)
        users: [
          { data: { firm_role: null, tenant_id: 't1' }, error: null },
          { data: { tenant_id: 't1' }, error: null },
          { data: { firm_role: null, tenant_id: 't1' }, error: null },
        ],
        deals: [
          { data: { id: 'd-1' }, error: null },
          { data: { tenant_id: 't1' }, error: null },
        ],
        deal_memberships: { data: { id: 'm-1' }, error: null },
        ai_usage: {
          data: [
            {
              deal_id: 'd-1', actor_id: 'u-md', source: 'screen', task: 'mail_screen',
              model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 100, cost_usd: '0.003',
              created_at: '2026-09-14T12:00:00Z',
              deal: { code: 'ZZTES-2026-586', codename: 'ZZ TEST PAX' },
              actor: { display_name: null, full_name: 'Marcelo Gumiero', email: 'md@bank.dev' },
            },
          ],
          error: null,
        },
      }),
    );
    const res = await GET(new Request('http://localhost/api/v1/ai-spend?dealId=ZZTES-2026-586'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { totalCostUsd: number; byDeal: { label: string }[]; byPerson: { label: string }[] }; recent: unknown[] };
    expect(body.summary.totalCostUsd).toBe(0.003);
    expect(body.summary.byDeal[0].label).toBe('ZZ TEST PAX');
    expect(body.summary.byPerson[0].label).toBe('Marcelo Gumiero');
    expect(body.recent).toHaveLength(1);
  });

  it('refuses the tenant-wide view to an external user and to a walled department', async () => {
    for (const actor of [
      { is_external: true, firm_role: null, department: null, tenant_id: 't1' },
      { is_external: false, firm_role: null, department: 'research', tenant_id: 't1' },
    ]) {
      signedIn(
        makeAdmin({
          users: [
            { data: { firm_role: null, tenant_id: 't1' }, error: null },
            { data: { tenant_id: 't1' }, error: null },
            { data: actor, error: null },
          ],
        }),
      );
      const res = await GET(new Request('http://localhost/api/v1/ai-spend'));
      expect(res.status).toBe(403);
    }
  });

  it('marks the summary as a window when more rows exist than the read limit', async () => {
    const many = Array.from({ length: 2001 }, (_, i) => ({
      deal_id: null, actor_id: 'u-md', source: 'screen', task: 'mail_screen', model: 'claude-sonnet-5',
      input_tokens: 1, output_tokens: 1, cost_usd: '0.000001', created_at: `2026-09-${String(1 + (i % 9)).padStart(2, '0')}T00:00:00Z`,
      deal: null, actor: { display_name: 'Marcelo', full_name: null, email: null },
    }));
    signedIn(
      makeAdmin({
        users: [
          { data: { firm_role: null, tenant_id: 't1' }, error: null },
          { data: { tenant_id: 't1' }, error: null },
          { data: { is_external: false, firm_role: 'cco', department: null, tenant_id: 't1' }, error: null },
        ],
        ai_usage: { data: many, error: null },
      }),
    );
    const res = await GET(new Request('http://localhost/api/v1/ai-spend'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window: { truncated: boolean; limit: number }; summary: { calls: number } };
    expect(body.window).toMatchObject({ truncated: true, limit: 2000 });
    expect(body.summary.calls).toBe(2000);
  });
});
