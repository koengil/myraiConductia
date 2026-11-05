import { createClient } from '@supabase/supabase-js';
import { TABLE } from '@/lib/constants/tables';

/**
 * Records one priced AI call on a deal, so the AI costs page has spend to
 * break down on a fresh database. Written straight to the local ledger the
 * compliance screen writes (source 'screen'); the hermetic tier makes no real
 * model call. Local-only: refuses any NEXT_PUBLIC_SUPABASE_URL that is not
 * 127.0.0.1 or localhost.
 */
export async function insertAiUsage(opts: { dealId: string; actorId: string; runId: string }): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) throw new Error('recording AI spend needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    throw new Error(`refusing to record AI spend against a non-local Supabase URL: ${url}`);
  }
  const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: deal, error: dealError } = await admin
    .from(TABLE.DEALS)
    .select('tenant_id')
    .eq('id', opts.dealId)
    .single();
  if (dealError || !deal) throw new Error(`could not read the deal's tenant: ${dealError?.message ?? 'no row'}`);

  const { error } = await admin.from(TABLE.AI_USAGE).insert({
    tenant_id: deal.tenant_id,
    deal_id: opts.dealId,
    actor_id: opts.actorId,
    source: 'screen',
    task: 'mail_screen',
    model: 'claude-opus-5',
    input_tokens: 1200,
    output_tokens: 300,
    cost_usd: 0.0081,
    external_id: `e2e-ai-costs-${opts.runId}`,
  });
  if (error) throw new Error(`could not record AI spend: ${error.message}`);
}
