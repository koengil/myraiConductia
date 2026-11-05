import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkAiBudget } from '../src/lib/ai/budget';
import { recordAiUsage } from '../src/lib/ai/usage';

/*
 * AI budget alerts (D83): every priced ledger write asks ai_budget_check()
 * whether its banker crossed 80% or 100% of the firm's monthly limit. The
 * thresholds, recipients and the once-a-month rule live in SQL and are run
 * against the CI database by supabase/tests/ai_budget_alerts.sql; these pin
 * the call and its never-throw rule.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeAdmin(opts: { upsertError?: { message: string } | null; rpc?: () => unknown; duplicate?: boolean } = {}) {
  const rpc = vi.fn(opts.rpc ?? (async () => ({ data: [], error: null })));
  const select = async () =>
    opts.upsertError ? { data: null, error: opts.upsertError } : { data: opts.duplicate ? [] : [{ id: 'row-1' }], error: null };
  const upsert = vi.fn(() => ({ select }));
  return { admin: { from: () => ({ upsert }), rpc } as never, rpc, upsert };
}

const row = {
  tenantId: 'tenant-1',
  actorId: 'user-1',
  source: 'twin_chat' as const,
  task: 'twin_chat',
  externalId: 'ext-1',
  model: 'claude-sonnet-5',
  costUsd: 0.25,
};

describe('checkAiBudget', () => {
  it('asks the database for the banker and returns the thresholds it alerted', async () => {
    const { admin, rpc } = fakeAdmin({ rpc: async () => ({ data: [80], error: null }) });
    expect(await checkAiBudget(admin, 'tenant-1', 'user-1')).toEqual({ alerted: [80], error: null });
    expect(rpc).toHaveBeenCalledWith('ai_budget_check', { p_tenant_id: 'tenant-1', p_actor_id: 'user-1' });
  });

  it('logs a database error and never throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({ rpc: async () => ({ data: null, error: { message: 'boom', code: '42883' } }) });
    expect(await checkAiBudget(admin, 'tenant-1', 'user-1')).toEqual({ alerted: [], error: 'boom' });
  });

  it('catches a client that throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({
      rpc: () => {
        throw new Error('network');
      },
    });
    expect(await checkAiBudget(admin, 'tenant-1', 'user-1')).toEqual({ alerted: [], error: 'network' });
  });
});

describe('recordAiUsage runs the budget check', () => {
  it('after a priced write, for the banker who spent it', async () => {
    const { admin, rpc } = fakeAdmin();
    expect(await recordAiUsage(admin, row)).toEqual({ error: null });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith('ai_budget_check', { p_tenant_id: 'tenant-1', p_actor_id: 'user-1' });
  });

  it('not when the call has no price, a zero price, or no actor', async () => {
    const { admin, rpc } = fakeAdmin();
    await recordAiUsage(admin, { ...row, costUsd: null, model: null });
    await recordAiUsage(admin, { ...row, costUsd: 0 });
    await recordAiUsage(admin, { ...row, source: 'discovery_extract', actorId: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('not when the row was already on the ledger (a repeated poll)', async () => {
    const { admin, rpc } = fakeAdmin({ duplicate: true });
    expect(await recordAiUsage(admin, row)).toEqual({ error: null });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('not when the ledger write failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, rpc } = fakeAdmin({ upsertError: { message: 'down' } });
    expect(await recordAiUsage(admin, row)).toEqual({ error: 'down' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps the ledger result when the budget check fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({ rpc: async () => ({ data: null, error: { message: 'boom' } }) });
    expect(await recordAiUsage(admin, row)).toEqual({ error: null });
  });
});
