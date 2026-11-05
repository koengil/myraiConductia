import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentRunRequester, recordAiUsage } from '../src/lib/ai/usage';
import { allowedDecision } from './helpers/modelDecision';
import { fullScreen } from '../src/lib/compliance/llm';

/*
 * AI cost tracking (#109), review fixes: a paid reply that does not parse
 * still reports its usage; an agent run's cost goes to its requester; a
 * failed ledger write is logged, never thrown.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const reply = (text: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'anthropic/claude-sonnet-5',
      usage: { input_tokens: 500, output_tokens: 40 },
      content: [{ type: 'text', text }],
    }),
  }) as unknown as Response;

// The model gate (#339) open on the DEV tenant's synthetic path: the pass runs, so its bill can be read.
const allowed = allowedDecision('mail_screen');

describe('the screen keeps the bill when the verdict is unreadable', () => {
  it('reports usage with no model verdict on malformed JSON', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'k');
    vi.stubGlobal('fetch', vi.fn(async () => reply('not json at all')));
    const r = await fullScreen('text', allowed);
    expect(r.llmChecked).toBe(false);
    expect(r.ai).toEqual({ model: 'claude-sonnet-5', inputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('reports usage with no model verdict on an unknown verdict value', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'k');
    vi.stubGlobal('fetch', vi.fn(async () => reply(JSON.stringify({ verdict: 'maybe', reasons: [] }))));
    const r = await fullScreen('text', allowed);
    expect(r.llmChecked).toBe(false);
    expect(r.ai?.inputTokens).toBe(500);
  });

  it('reports nothing without a key', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    const r = await fullScreen('text', allowed);
    expect(r.llmChecked).toBe(false);
    expect(r.ai).toBeUndefined();
  });
});

function fakeAdmin(result: { data: unknown; error: { message: string } | null }) {
  const calls: Record<string, unknown[][]> = {};
  const builder: Record<string, unknown> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return builder;
  };
  for (const k of ['select', 'eq', 'contains', 'order', 'limit', 'upsert']) builder[k] = record(k);
  builder.maybeSingle = () => Promise.resolve(result);
  builder.then = (f: (v: unknown) => unknown) => Promise.resolve(result).then(f);
  return { admin: { from: record('from') } as never, calls };
}

describe('agentRunRequester', () => {
  it('reads the actor of the trigger audit row for the execution id', async () => {
    const { admin, calls } = fakeAdmin({ data: { actor_id: 'u-requester' }, error: null });
    await expect(agentRunRequester(admin, 'exec-1')).resolves.toBe('u-requester');
    expect(calls.from[0]).toEqual(['audit_log']);
    expect(calls.contains[0]).toEqual(['detail', { kind: 'agent_run', executionId: 'exec-1' }]);
    expect(calls.order[0]).toEqual(['ts', { ascending: false }]);
  });

  it('returns null when no trigger row exists or the lookup fails', async () => {
    expect(await agentRunRequester(fakeAdmin({ data: null, error: null }).admin, 'x')).toBeNull();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await agentRunRequester(fakeAdmin({ data: null, error: { message: 'boom' } }).admin, 'x')).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe('recordAiUsage', () => {
  it('upserts on (source, external_id) ignoring duplicates and prices from the table', async () => {
    const { admin, calls } = fakeAdmin({ data: null, error: null });
    const r = await recordAiUsage(admin, {
      tenantId: 't1', dealId: 'd1', actorId: 'u1', source: 'screen', task: 'mail_screen', externalId: 'ext-1',
      model: 'claude-sonnet-5', usage: { inputTokens: 1000, outputTokens: 100 },
    });
    expect(r.error).toBeNull();
    const [row, opts] = calls.upsert[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(row).toMatchObject({ tenant_id: 't1', deal_id: 'd1', actor_id: 'u1', source: 'screen', cost_usd: 0.003, external_id: 'ext-1' });
    expect(opts).toEqual({ onConflict: 'source,external_id', ignoreDuplicates: true });
  });

  it('records a discovery extraction with no actor, priced from tokens (T13)', async () => {
    const { admin, calls } = fakeAdmin({ data: null, error: null });
    const r = await recordAiUsage(admin, {
      tenantId: 't1', actorId: null, source: 'discovery_extract', task: 'milestone_extract', externalId: 'msg_01',
      model: 'claude-sonnet-5', usage: { inputTokens: 1000, outputTokens: 100 },
    });
    expect(r.error).toBeNull();
    const [row] = calls.upsert[0] as [Record<string, unknown>];
    expect(row).toMatchObject({ actor_id: null, source: 'discovery_extract', task: 'milestone_extract', cost_usd: 0.003, external_id: 'msg_01' });
  });

  it('refuses a null actor for any other source, writing nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin, calls } = fakeAdmin({ data: null, error: null });
    const r = await recordAiUsage(admin, { tenantId: 't1', actorId: null, source: 'screen', task: 'mail_screen', externalId: 'x' });
    expect(r.error).toBe('source screen needs an actor');
    expect(calls.upsert).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it('logs and returns a write error instead of throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeAdmin({ data: null, error: { message: 'rls' } });
    const r = await recordAiUsage(admin, { tenantId: 't1', actorId: 'u1', source: 'agent_run', task: 'p1-s9', externalId: 'exec', costUsd: 0.41 });
    expect(r.error).toBe('rls');
    expect(err).toHaveBeenCalled();
  });
});
