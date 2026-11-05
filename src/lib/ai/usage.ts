import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';
import { checkAiBudget } from './budget';
import { costForUsage, type TokenUsage } from './pricing';

/** The ledger's sources, in the order of the ai_usage_source_check CHECK (latest: 20261013100000). */
export const AI_USAGE_SOURCES = ['screen', 'agent_run', 'bench_chat', 'twin_chat', 'discovery_extract', 'skill_run', 'skill_authoring', 'skill_revision'] as const;
export type AiUsageSource = (typeof AI_USAGE_SOURCES)[number];

/** One AI call as the compliance screen's Claude pass reports it. */
export type AiCallUsage = TokenUsage & {
  model: string;
};

export type AiUsageInsert = {
  tenantId: string;
  dealId?: string | null;
  companyId?: string | null;
  /** Null for `discovery_extract` alone: the extractor has no user actor (the ai_usage_actor_check CHECK). */
  actorId: string | null;
  source: AiUsageSource;
  task: string;
  externalId: string;
  model?: string | null;
  usage?: TokenUsage | null;
  /** A cost the provider already priced (Ignatious runs). Wins over the table. */
  costUsd?: number | null;
};

/** Read the usage block of an Anthropic Messages API reply. */
export function usageFromAnthropicReply(data: unknown): AiCallUsage | null {
  if (!data || typeof data !== 'object') return null;
  const reply = data as {
    model?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
  const usage = reply.usage;
  if (!usage || typeof reply.model !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    model: reply.model,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
  };
}

/**
 * A gateway reply names its model `anthropic/<id>`; the price table and the
 * ledger rows use the bare name (as discovery rows do).
 */
export function ledgerUsage(u: AiCallUsage | null): AiCallUsage | null {
  return u ? { ...u, model: u.model.replace(/^anthropic\//, '') } : null;
}

/**
 * Record one AI call on the ledger. The (source, external_id) key is what
 * makes a repeated status poll on the same agent run write once; a screen
 * carries a fresh uuid, one row per pass. A priced row then runs the budget
 * check, which alerts the banker and the firm's overseers (D83). Errors are
 * logged and returned, never thrown: the ledger must not fail the action it
 * records.
 */
export async function recordAiUsage(
  admin: SupabaseClient,
  row: AiUsageInsert,
): Promise<{ error: string | null }> {
  if (row.actorId === null && row.source !== 'discovery_extract') {
    const error = `source ${row.source} needs an actor`;
    console.error('[ai-usage] refused: needs an actor', row.source, row.externalId);
    return { error };
  }
  const model = row.model ?? null;
  const usage = row.usage ?? null;
  const cost =
    typeof row.costUsd === 'number'
      ? Math.round(row.costUsd * 1_000_000) / 1_000_000
      : model && usage
        ? costForUsage(model, usage)
        : null;

  const { data, error } = await admin.from(TABLE.AI_USAGE).upsert(
    {
      tenant_id: row.tenantId,
      deal_id: row.dealId ?? null,
      company_id: row.companyId ?? null,
      actor_id: row.actorId,
      source: row.source,
      task: row.task,
      model,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      cache_read_tokens: usage?.cacheReadTokens ?? null,
      cache_write_tokens: usage?.cacheWriteTokens ?? null,
      cost_usd: cost,
      external_id: row.externalId,
    },
    { onConflict: 'source,external_id', ignoreDuplicates: true },
  ).select('id');
  // An ignored duplicate (a repeated agent-run poll) returns no row.
  const inserted = (data?.length ?? 0) > 0;
  if (error) {
    console.error('[ai-usage] ledger write failed', row.source, row.externalId, errorCodeOf(error));
  } else if (inserted && row.actorId && cost !== null && cost > 0) {
    // A newly priced call may push its banker past the firm's monthly budget
    // (D83). One more round trip per new priced row (ai_budget_check), even
    // when the firm has no budget; the function returns at once in that case.
    await checkAiBudget(admin, row.tenantId, row.actorId);
  }
  return { error: error?.message ?? null };
}

/**
 * Who asked for an agent run: the actor on the trigger's audit row. Cost is
 * attributed to the requester, never to whoever happens to poll the status.
 * Null when the trigger left no row (a run started outside this app).
 */
export async function agentRunRequester(
  admin: SupabaseClient,
  executionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from(TABLE.AUDIT_LOG)
    .select('actor_id')
    .eq('action', 'create')
    .contains('detail', { kind: 'agent_run', executionId })
    .order('ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[ai-usage] requester lookup failed', executionId, errorCodeOf(error));
    return null;
  }
  return typeof data?.actor_id === 'string' ? data.actor_id : null;
}
