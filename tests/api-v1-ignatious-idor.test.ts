import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import {
  executionBelongsToCompany,
  executionBelongsToDeal,
} from '@/lib/ignatious/routeContext';

/*
 * Prelaunch audit PL-05: run ids were not tied to their deal or company.
 *
 * Every proxy route authorised the deal or company in the URL and then handed
 * the caller's own executionId straight to the control plane, so a member of
 * any deal could read, answer, cancel, download artifacts from, and bill
 * another tenant's run by naming its id. Two of those are writes: answerRun
 * feeds a paused run, and the presearch GET copies a completed run's memo into
 * the caller's own lead.
 *
 * These binders are the fix, and the query shape is the contract. Two of them
 * because the audit rows differ: deal-scoped triggers set deal_id, while
 * presearch and debrief leave it NULL and carry the lead in detail.companyId.
 */

function fakeAdmin(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return builder;
    };
  for (const k of ['select', 'eq', 'contains', 'limit']) builder[k] = record(k);
  builder.maybeSingle = () => Promise.resolve(result);
  return { admin: { from: record('from') } as never, calls };
}

describe('executionBelongsToDeal', () => {
  it('binds the run to THIS deal and matches the executionId inside detail', async () => {
    const { admin, calls } = fakeAdmin({ data: { id: 'a-1' }, error: null });
    await expect(executionBelongsToDeal(admin, 'd-1', 'exec_1')).resolves.toBe(true);

    expect(calls.from[0]).toEqual(['audit_log']);
    expect(calls.eq).toEqual(
      expect.arrayContaining([
        ['deal_id', 'd-1'],
        ['action', 'create'],
      ]),
    );
    expect(calls.contains[0]).toEqual([
      'detail',
      { kind: 'agent_run', executionId: 'exec_1' },
    ]);
  });

  it('DENIES a run belonging to another deal', async () => {
    // No audit row pairs this executionId with this deal.
    const { admin } = fakeAdmin({ data: null, error: null });
    await expect(executionBelongsToDeal(admin, 'd-1', 'exec_from_deal_2')).resolves.toBe(false);
  });

  it('is NOT scoped to the actor, so a colleague run on the same deal is visible', async () => {
    // Deliberately unlike latestExecutionId, which is actor-scoped to resume
    // the caller's own panel. Deal members share a deal's runs.
    const { admin, calls } = fakeAdmin({ data: { id: 'a-1' }, error: null });
    await executionBelongsToDeal(admin, 'd-1', 'exec_1');
    expect(calls.eq.map((args) => args[0])).not.toContain('actor_id');
  });

  it('throws on a query error rather than reading it as "not yours"', async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: 'audit_log is unavailable', code: '42P01' } });
    const error = await executionBelongsToDeal(admin, 'd-1', 'exec_1').catch((e: unknown) => e);
    // The failure carries the step and the code, never the database's own text (#331).
    expect((error as Error).message).toBe('Agent run lookup failed (42P01)');
  });
});

describe('executionBelongsToCompany', () => {
  it('matches on detail.companyId, since these rows carry no deal_id', async () => {
    const { admin, calls } = fakeAdmin({ data: { id: 'a-1' }, error: null });
    await expect(executionBelongsToCompany(admin, 'c-1', 'exec_1')).resolves.toBe(true);

    expect(calls.contains[0]).toEqual([
      'detail',
      { kind: 'agent_run', companyId: 'c-1', executionId: 'exec_1' },
    ]);
    // Matching on deal_id here would never bind a presearch or debrief run.
    expect(calls.eq.map((args) => args[0])).not.toContain('deal_id');
  });

  it('DENIES a run belonging to another company', async () => {
    // The presearch GET would otherwise graft company B's memo onto company A.
    const { admin } = fakeAdmin({ data: null, error: null });
    await expect(executionBelongsToCompany(admin, 'c-1', 'exec_from_company_2')).resolves.toBe(
      false,
    );
  });

  it('throws on a query error rather than reading it as "not yours"', async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: 'audit_log is unavailable', code: '42P01' } });
    const error = await executionBelongsToCompany(admin, 'c-1', 'exec_1').catch((e: unknown) => e);
    expect((error as Error).message).toBe('Agent run lookup failed (42P01)');
  });
});
