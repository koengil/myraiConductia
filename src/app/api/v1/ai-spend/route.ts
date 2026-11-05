import { NextResponse } from 'next/server';

import { firmMailAccess, userCanAccessDeal } from '@/lib/api/v1/access';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { summarizeSpend, type AiUsageRow } from '@/lib/ai/spend';
import { COMPANY_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import { TABLE } from '@/lib/constants/tables';

const READ_LIMIT = 2000;

type LedgerRow = {
  deal_id: string | null;
  actor_id: string | null;
  source: string;
  task: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | string | null;
  created_at: string;
  deal: { code: string; codename: string } | { code: string; codename: string }[] | null;
  actor: { display_name: string | null; full_name: string | null; email: string | null }
    | { display_name: string | null; full_name: string | null; email: string | null }[]
    | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * GET /api/v1/ai-spend?dealId=<id or code>
 *
 * The AI spend ledger, summarized by deal, person, task and model (#109).
 * With a dealId: that deal's rows, for anyone who can access the deal.
 * Without: every row in the caller's tenant (#155), for firm overseers (CCO,
 * admin) and bank directors only, the same roles the AI Costs page is shown
 * to (showAiCostsNav). A banker sees only the deals they sit on, so the
 * firm-wide read must not hand them the code name of every deal and the spend
 * of every colleague; they are refused, and read each deal's spend with a
 * dealId instead.
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const dealRef = new URL(request.url).searchParams.get('dealId')?.trim() || null;

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id, company_role')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  let dealId: string | null = null;
  if (dealRef) {
    const base = auth.admin.from('deals').select('id');
    const { data: deal } = await (isUuid(dealRef) ? base.eq('id', dealRef) : base.eq('code', dealRef)).maybeSingle();
    if (!deal) return jsonError('Deal not found', 404);
    dealId = deal.id as string;
    const allowed = await userCanAccessDeal(auth.admin, auth.user.id, dealId);
    if (!allowed) return dealNotVisible();
  } else {
    // Tenant-wide reach follows the firm's other tenant-wide reads (company
    // search, the mail outbox): internal, and not behind the research /
    // trading wall. Same predicate, so the two never drift.
    const reach = await firmMailAccess(auth.admin, auth.user.id);
    if (!reach.ok) return jsonError('Forbidden', 403);
    const overseer =
      reach.firmRole === FIRM_ROLE.CCO ||
      reach.firmRole === FIRM_ROLE.ADMIN ||
      profile.company_role === COMPANY_ROLE.DIRECTOR;
    if (!overseer) return jsonError('Forbidden', 403);
  }

  let query = auth.admin
    .from(TABLE.AI_USAGE)
    .select(
      'deal_id, actor_id, source, task, model, input_tokens, output_tokens, cost_usd, created_at, ' +
        'deal:deals(code, codename), actor:users!ai_usage_actor_id_fkey(display_name, full_name, email)',
    )
    .eq('tenant_id', profile.tenant_id)
    .order('created_at', { ascending: false })
    // One past the window: the reader is told when the total is a window,
    // never handed a truncated number as the whole.
    .limit(READ_LIMIT + 1);
  if (dealId) query = query.eq('deal_id', dealId);

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  const all = (data ?? []) as unknown as LedgerRow[];
  const truncated = all.length > READ_LIMIT;
  const rows: AiUsageRow[] = all.slice(0, READ_LIMIT).map((r) => {
    const deal = one(r.deal);
    const actor = one(r.actor);
    return {
      deal_id: r.deal_id,
      deal_code: deal?.code ?? null,
      deal_codename: deal?.codename ?? null,
      actor_id: r.actor_id,
      actor_name: actor?.display_name?.trim() || actor?.full_name?.trim() || actor?.email || null,
      source: r.source,
      task: r.task,
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cost_usd: r.cost_usd,
      created_at: r.created_at,
    };
  });

  const summary = summarizeSpend(rows);
  return NextResponse.json({
    scope: dealId ? { dealId } : { tenant: true },
    detail: 'full',
    // When truncated, the summary covers the newest READ_LIMIT calls, from
    // `window.since` on; the panel says so instead of showing it as a total.
    window: {
      truncated,
      limit: READ_LIMIT,
      since: rows.length ? rows[rows.length - 1].created_at : null,
    },
    summary,
    recent: rows.slice(0, 25).map((r) => ({
      at: r.created_at,
      deal: r.deal_codename ?? r.deal_code ?? null,
      person: r.actor_name,
      task: r.task,
      model: r.model,
      costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    })),
  });
}
