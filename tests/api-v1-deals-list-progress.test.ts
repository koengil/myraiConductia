// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/*
 * GET /api/v1/deals progress fields for the Conductor Center.
 *
 * Driven through the real supabase-js query builder with a capture fetch, so
 * the select string and filters on the wire are what is pinned:
 *   - the deal list keeps its scoping (member join, tenant for overseers);
 *   - the current-step and steps embeds are in the one deal-list request;
 *   - an internal caller gets assignee, run state and per-phase progress,
 *     counted by the rail's rule (Gate 0 intake steps done);
 *   - an outside party gets null run state and null progress.
 */

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { GET } from '@/app/api/v1/deals/route';

type Profile = { firm_role: string | null; tenant_id: string; is_external: boolean };

const STEPS = [
  // Gate 0 intake steps: done for every listed deal, whatever is stored.
  { step_id: 'p1-s7', phase_index: 1, status: 'skipped_entry', removed_at: null },
  { step_id: 'p1-s6', phase_index: 1, status: 'pending', removed_at: null },
  { step_id: 'g0-notify', phase_index: 1, status: 'complete', removed_at: null },
  { step_id: 'p1-s8', phase_index: 1, status: 'skipped_entry', removed_at: null },
  { step_id: 'p1-s9', phase_index: 1, status: 'complete', removed_at: null },
  { step_id: 'p1-s10', phase_index: 1, status: 'skipped', removed_at: null },
  { step_id: 'p1-s11', phase_index: 1, status: 'current', removed_at: null },
  { step_id: 'p1-s12', phase_index: 1, status: 'pending', removed_at: null },
  { step_id: 'custom:x', phase_index: 1, status: 'complete', removed_at: '2026-10-01T00:00:00Z' },
  { step_id: 'p2-s26', phase_index: 2, status: 'pending', removed_at: null },
];

const DEAL = {
  id: 'd1',
  code: 'ALDER-2026-965',
  codename: 'Project Alder',
  status: 'active',
  created_at: '2026-09-18T00:00:00Z',
  entry_step_seq: 8,
  current_step_seq: 11,
  current_step: {
    step_id: 'p1-s11',
    seq: 11,
    phase_index: 1,
    definition: null,
    removed_at: null,
    assigned_to: 'u-7',
    bench_run_status: 'running',
    assignee: { id: 'u-7', display_name: null, full_name: 'Alex Chen', email: 'alex@bank.dev' },
  },
  steps: STEPS,
};

function stubAdmin(profile: Profile, deals: unknown[] = [DEAL], failSelect?: string) {
  const urls: string[] = [];
  const stubFetch: typeof fetch = async (input) => {
    const raw = input instanceof Request ? input.url : String(input);
    urls.push(raw);
    const { pathname, searchParams } = new URL(raw);
    if (failSelect && pathname.endsWith('/users') && searchParams.get('select') === failSelect) {
      return new Response(JSON.stringify({ message: 'profile read failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = pathname.endsWith('/users')
      ? { ...profile, status: 'active' }
      : pathname.endsWith('/deals')
        ? deals
        : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createClient('http://stub.local', 'k', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: stubFetch },
  });
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: 'u-1', email: 'u@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () => Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(client as never);
  return { urls };
}

type ListedDealJson = {
  currentStep: { assignee: unknown; benchRunStatus: unknown } | null;
  phaseProgress: unknown;
};

async function list(): Promise<ListedDealJson[]> {
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { deals: ListedDealJson[] }).deals;
}

function dealsRequest(urls: string[]): URL {
  const found = urls.map((u) => new URL(u)).filter((u) => u.pathname.endsWith('/deals'));
  expect(found).toHaveLength(1);
  return found[0];
}

afterEach(() => vi.clearAllMocks());

describe('GET /api/v1/deals progress fields', () => {
  it('reads both embeds in the one deal-list request, scoped through the caller\'s membership', async () => {
    const { urls } = stubAdmin({ firm_role: null, tenant_id: 't1', is_external: false });
    await list();
    const req = dealsRequest(urls);
    const select = req.searchParams.get('select') ?? '';
    expect(select).toContain(
      'current_step:deal_steps!deals_current_deal_step_id_fkey(step_id,seq,phase_index,definition,removed_at,assigned_to,bench_run_status,assignee:users!deal_steps_assigned_to_fkey(id,display_name,full_name,email))',
    );
    expect(select).toContain('steps:deal_steps!deal_steps_deal_id_fkey(step_id,phase_index,status,removed_at)');
    expect(select).toContain('deal_memberships!inner(user_id)');
    expect(req.searchParams.get('deal_memberships.user_id')).toBe('eq.u-1');
    expect(req.searchParams.get('tenant_id')).toBeNull();
  });

  it('an overseer\'s list stays tenant-scoped', async () => {
    const { urls } = stubAdmin({ firm_role: 'cco', tenant_id: 't1', is_external: false });
    await list();
    const req = dealsRequest(urls);
    expect(req.searchParams.get('tenant_id')).toBe('eq.t1');
    expect(req.searchParams.get('select')).not.toContain('deal_memberships!inner');
  });

  it('gives an internal caller the assignee, the run state and per-phase progress by the rail\'s rule', async () => {
    stubAdmin({ firm_role: null, tenant_id: 't1', is_external: false });
    const [deal] = await list();
    expect(deal.currentStep?.assignee).toEqual({ id: 'u-7', name: 'Alex Chen' });
    expect(deal.currentStep?.benchRunStatus).toBe('running');
    // Phase 1: the three Gate 0 steps (done) + s9 complete + s10 skipped = 5
    // done; s8 (before entry) and the removed custom step are not counted;
    // s11 and s12 are open, so 5 of 7.
    expect(deal.phaseProgress).toEqual([
      { phaseIndex: 1, done: 5, total: 7 },
      { phaseIndex: 2, done: 0, total: 1 },
    ]);
  });

  it('gives an outside party null run state and null progress, and keeps the assignee', async () => {
    stubAdmin({ firm_role: null, tenant_id: 't1', is_external: true });
    const [deal] = await list();
    expect(deal.currentStep?.benchRunStatus).toBeNull();
    expect(deal.phaseProgress).toBeNull();
    expect(deal.currentStep?.assignee).toEqual({ id: 'u-7', name: 'Alex Chen' });
  });

  it('when the caller\'s profile read fails, still lists the deals (200) with null run state and null progress', async () => {
    // classifyInternalUser reads users.is_external; a failed read is not an
    // internal caller, so the internal-only fields are withheld. The current
    // step and its assignee stay, as for an outside party.
    const { urls } = stubAdmin({ firm_role: null, tenant_id: 't1', is_external: false }, [DEAL], 'is_external');
    const deals = await list();
    expect(urls.some((u) => new URL(u).searchParams.get('select') === 'is_external')).toBe(true);
    expect(deals).toHaveLength(1);
    const [deal] = deals;
    expect(deal.currentStep?.benchRunStatus).toBeNull();
    expect(deal.phaseProgress).toBeNull();
    expect(deal.currentStep?.assignee).toEqual({ id: 'u-7', name: 'Alex Chen' });
  });

  it('says null rather than guessing when nothing is assigned or the steps were not read', async () => {
    stubAdmin({ firm_role: null, tenant_id: 't1', is_external: false }, [
      {
        ...DEAL,
        current_step: { ...DEAL.current_step, assigned_to: null, assignee: null, bench_run_status: null },
        steps: undefined,
      },
    ]);
    const [deal] = await list();
    expect(deal.currentStep?.assignee).toBeNull();
    expect(deal.currentStep?.benchRunStatus).toBeNull();
    expect(deal.phaseProgress).toBeNull();
  });
});
