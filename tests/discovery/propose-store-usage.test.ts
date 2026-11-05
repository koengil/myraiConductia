import { describe, expect, it, vi } from 'vitest';

import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { supabaseProposalStore } from '@/lib/discovery/propose/store';

// The real proposal store's ledger write (#645): one billed attempt becomes one ai_usage row, through
// recordAiUsage, against a chainable fake of the Supabase client (the tests/ai-usage-record.test.ts pattern).

function fakeAdmin(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return builder;
  };
  for (const k of ['select', 'upsert']) builder[k] = record(k);
  builder.then = (f: (v: unknown) => unknown) => Promise.resolve(result).then(f);
  return { admin: { from: record('from') } as never, calls };
}

describe('supabaseProposalStore.recordUsage', () => {
  it('writes a priced discovery row with no actor, the model without its gateway prefix', async () => {
    const { admin, calls } = fakeAdmin({ data: [{ id: 'row-1' }], error: null });
    await supabaseProposalStore(admin).recordUsage(DEV_TENANT_ID, {
      externalId: 'msg_1',
      model: 'anthropic/claude-haiku-5.5',
      usage: { model: 'anthropic/claude-haiku-5.5', inputTokens: 2000, outputTokens: 100 },
    });
    expect(calls.from[0]).toEqual(['ai_usage']);
    const [row, opts] = calls.upsert[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(row).toMatchObject({
      tenant_id: DEV_TENANT_ID,
      actor_id: null,
      deal_id: null,
      source: 'discovery_extract',
      task: 'deal_proposal',
      external_id: 'msg_1',
      model: 'claude-haiku-5.5',
      input_tokens: 2000,
      output_tokens: 100,
      cost_usd: (2000 * 0.1 + 100 * 0.5) / 1_000_000,
    });
    expect(opts).toEqual({ onConflict: 'source,external_id', ignoreDuplicates: true });
  });

  it('writes an unpriced row for a reply without usage: the model alone, null tokens and a null cost', async () => {
    const { admin, calls } = fakeAdmin({ data: [{ id: 'row-2' }], error: null });
    await supabaseProposalStore(admin).recordUsage(DEV_TENANT_ID, {
      externalId: 'local:00000000-0000-4000-8000-000000000001',
      model: 'anthropic/claude-haiku-5.5',
      usage: null,
    });
    const [row] = calls.upsert[0] as [Record<string, unknown>];
    expect(row).toMatchObject({
      external_id: 'local:00000000-0000-4000-8000-000000000001',
      model: 'claude-haiku-5.5',
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      cost_usd: null,
    });
  });

  it('throws a code when the ledger refuses the row, never the database message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({ data: null, error: { message: 'permission denied for table ai_usage', code: '42501' } });
    const write = supabaseProposalStore(admin).recordUsage(DEV_TENANT_ID, {
      externalId: 'msg_2',
      model: 'anthropic/claude-haiku-5.5',
      usage: { model: 'anthropic/claude-haiku-5.5', inputTokens: 2000, outputTokens: 100 },
    });
    await expect(write).rejects.toThrow(new Error('record ai usage failed: ledger'));
    err.mockRestore();
  });
});
