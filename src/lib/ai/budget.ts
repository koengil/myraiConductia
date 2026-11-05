import type { SupabaseClient } from '@supabase/supabase-js';

import { errorCodeOf } from '@/lib/errors/upstream';

/** The alert points, in percent of the monthly limit (ai_budget_alerts CHECK). */
export const AI_BUDGET_THRESHOLDS = [80, 100] as const;

/** Highest limit the API accepts: far above any real month, well inside numeric(12,2). */
export const AI_BUDGET_MAX_USD = 1_000_000;

/**
 * Compare one banker's spend this month with the firm's limit and send the
 * alerts not yet sent (D83). The thresholds, the sum and the once-a-month rule
 * all live in ai_budget_check(); this only calls it. Alerts only: nothing is
 * refused at the limit. Never throws, like the ledger write it follows.
 */
export async function checkAiBudget(
  admin: SupabaseClient,
  tenantId: string,
  actorId: string,
): Promise<{ alerted: number[]; error: string | null }> {
  try {
    const { data, error } = await admin.rpc('ai_budget_check', {
      p_tenant_id: tenantId,
      p_actor_id: actorId,
    });
    if (error) {
      console.error('[ai-budget] check failed', errorCodeOf(error));
      return { alerted: [], error: error.message };
    }
    return { alerted: Array.isArray(data) ? (data as number[]) : [], error: null };
  } catch (error) {
    console.error('[ai-budget] check failed', errorCodeOf(error));
    return { alerted: [], error: error instanceof Error ? error.message : 'check failed' };
  }
}
