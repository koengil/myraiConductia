import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { latestExecutionId } from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/route';

/*
 * The mount-time resume (bug bash Finding 3) reads the newest agent_run audit
 * row. The query shape is the contract here: audit_log stamps `ts` (not
 * `created_at`), the lookup is scoped to the actor, and a query error must
 * surface, never read as "no run".
 */

function fakeAdmin(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return builder;
  };
  for (const k of ['select', 'eq', 'contains', 'order', 'limit']) builder[k] = record(k);
  builder.maybeSingle = () => Promise.resolve(result);
  return { admin: { from: record('from') } as never, calls };
}

describe('latestExecutionId — newest agent_run row on the step', () => {
  it('orders by ts, scopes to the deal, the actor and the step, and returns the id', async () => {
    const { admin, calls } = fakeAdmin({
      data: { detail: { kind: 'agent_run', stepId: 'p1-s9', executionId: 'exec_c7f187d1e57f5f55' } },
      error: null,
    });
    await expect(latestExecutionId(admin, 'd-1', 'p1-s9', 'u-md')).resolves.toBe(
      'exec_c7f187d1e57f5f55',
    );
    expect(calls.from[0]).toEqual(['audit_log']);
    expect(calls.order[0]).toEqual(['ts', { ascending: false }]);
    expect(calls.eq).toEqual(
      expect.arrayContaining([
        ['deal_id', 'd-1'],
        ['actor_id', 'u-md'],
        ['action', 'create'],
      ]),
    );
    expect(calls.contains[0]).toEqual(['detail', { kind: 'agent_run', stepId: 'p1-s9' }]);
  });

  it('returns null when the step never ran', async () => {
    const { admin } = fakeAdmin({ data: null, error: null });
    await expect(latestExecutionId(admin, 'd-1', 'p1-s9', 'u-md')).resolves.toBeNull();
  });

  it('throws on a query error instead of reading it as "no run"', async () => {
    const { admin } = fakeAdmin({
      data: null,
      error: { message: 'column audit_log.created_at does not exist', code: '42703' },
    });
    const error = await latestExecutionId(admin, 'd-1', 'p1-s9', 'u-md').catch((e: unknown) => e);
    expect((error as Error).message).toBe('Agent run lookup failed (42703)');
  });
});
