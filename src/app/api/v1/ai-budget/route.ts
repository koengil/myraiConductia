import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { AI_BUDGET_MAX_USD } from '@/lib/ai/budget';
import { firmMailAccess } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { COMPANY_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';

type Reach = { tenantId: string; canEdit: boolean };

/**
 * The same readers as the firm-wide AI spend (CCO, admin, bank director, not
 * behind the research / trading wall); only a CCO or admin sets the limit.
 */
async function budgetReach(
  admin: SupabaseClient,
  userId: string,
): Promise<Reach | null> {
  const reach = await firmMailAccess(admin, userId);
  if (!reach.ok || !reach.tenantId) return null;
  const canEdit = reach.firmRole === FIRM_ROLE.CCO || reach.firmRole === FIRM_ROLE.ADMIN;
  if (canEdit) return { tenantId: reach.tenantId, canEdit };
  const { data: profile } = await admin.from('users').select('company_role').eq('id', userId).maybeSingle();
  if (profile?.company_role !== COMPANY_ROLE.DIRECTOR) return null;
  return { tenantId: reach.tenantId, canEdit: false };
}

/**
 * GET /api/v1/ai-budget
 *
 * The firm's monthly AI budget per banker (D83): `monthlyLimitUsd` is null
 * when none is set. `canEdit` tells the AI Costs page whether to offer the form.
 */
export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const reach = await budgetReach(auth.admin, auth.user.id);
  if (!reach) return jsonError('Forbidden', 403);

  const { data, error } = await auth.admin
    .from(TABLE.AI_BUDGETS)
    .select('monthly_limit_usd, updated_at')
    .eq('tenant_id', reach.tenantId)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    monthlyLimitUsd: data?.monthly_limit_usd == null ? null : Number(data.monthly_limit_usd),
    updatedAt: data?.updated_at ?? null,
    canEdit: reach.canEdit,
  });
}

/**
 * PUT /api/v1/ai-budget  { monthlyLimitUsd: number | null }
 *
 * Sets the limit (rounded to cents), or removes it with null. CCO or admin
 * only; audited as an `update` with `kind: 'ai_budget'`. Alerts already sent
 * this month stay sent: a raised limit does not re-arm them until next month.
 */
export async function PUT(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const reach = await budgetReach(auth.admin, auth.user.id);
  if (!reach?.canEdit) return jsonError('Forbidden', 403);

  let body: { monthlyLimitUsd?: unknown };
  try {
    body = (await request.json()) as { monthlyLimitUsd?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const raw = body.monthlyLimitUsd;
  if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw))) {
    return jsonError('monthlyLimitUsd must be a number or null', 400);
  }
  const limit = raw === null ? null : Math.round(raw * 100) / 100;
  if (limit !== null && (limit <= 0 || limit > AI_BUDGET_MAX_USD)) {
    return jsonError(`monthlyLimitUsd must be above 0 and at most ${AI_BUDGET_MAX_USD}`, 400);
  }

  const { data: before } = await auth.admin
    .from(TABLE.AI_BUDGETS)
    .select('monthly_limit_usd')
    .eq('tenant_id', reach.tenantId)
    .maybeSingle();
  const previous = before?.monthly_limit_usd == null ? null : Number(before.monthly_limit_usd);

  const { error } =
    limit === null
      ? await auth.admin.from(TABLE.AI_BUDGETS).delete().eq('tenant_id', reach.tenantId)
      : await auth.admin.from(TABLE.AI_BUDGETS).upsert(
          {
            tenant_id: reach.tenantId,
            monthly_limit_usd: limit,
            updated_by: auth.user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'tenant_id' },
        );
  if (error) return jsonError(error.message, 500);

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    tenant_id: reach.tenantId,
    actor_id: auth.user.id,
    action: AUDIT_ACTION.UPDATE,
    detail: { kind: 'ai_budget', from: previous, to: limit },
  });
  // The limit is already saved: a 500 here would tell the card the save failed.
  if (auditError) console.error('[ai-budget] saved but audit write failed', reach.tenantId, errorCodeOf(auditError));

  return NextResponse.json({ monthlyLimitUsd: limit, canEdit: true });
}
