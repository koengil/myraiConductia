import { NextResponse } from 'next/server';
import { userCanAccessDeal, userIsDealMd } from '@/lib/api/v1/access';
import { auditFailed, isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { TABLE } from '@/lib/constants/tables';

type RouteContext = { params: Promise<{ dealId: string }> };

/**
 * Persist rail position. The MD (or a member) advancing on the rail writes the
 * new cursor back to deals.current_step_seq so it survives a reload — advances
 * were session-only before. A REGRESS (moving the cursor earlier) is MD-gated;
 * a forward advance is open to any deal member. Every change is audited as
 * 'advance' with the from/to seq. The segment is the deal CODE or UUID (G14).
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;

  let body: { currentStepSeq?: number };
  try {
    body = (await request.json()) as { currentStepSeq?: number };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const nextSeq = body.currentStepSeq;
  if (typeof nextSeq !== 'number' || !Number.isInteger(nextSeq) || nextSeq < 1) {
    return jsonError('currentStepSeq must be a positive integer', 400);
  }

  // Resolve the canonical row (code or UUID), then gate on the real id.
  const base = auth.admin.from('deals').select('id, code, current_step_seq');
  const { data: deal, error: dealError } = await (isUuid(dealId)
    ? base.eq('id', dealId)
    : base.eq('code', dealId)
  ).maybeSingle();
  if (dealError) return jsonError(dealError.message, 500);
  if (!deal) return jsonError('Deal not found', 404);

  const isMember = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!isMember) return dealNotVisible();

  const fromSeq = (deal.current_step_seq as number | null) ?? 1;
  // Moving the rail backwards is a supervisory action — MD (or admin) only.
  if (nextSeq < fromSeq) {
    const isMd = await userIsDealMd(auth.admin, auth.user.id, deal.id);
    if (!isMd) return jsonError('Only the deal MD can move the rail backwards', 403);
  }

  const { data: target, error: targetError } = await auth.admin
    .from(TABLE.DEAL_STEPS)
    .select('id')
    .eq('deal_id', deal.id)
    .eq('seq', nextSeq)
    .is('removed_at', null)
    .maybeSingle();
  if (targetError) return jsonError(targetError.message, 500);
  if (!target) return jsonError('That step is not on this project rail', 409);

  // The move and its audit row commit together (#249): a rejected audit
  // insert rolls the move back, so there is never an unaudited cursor.
  const { error: moveError } = await auth.admin.rpc('deal_move_cursor', {
    p_deal_id: deal.id,
    p_actor_id: auth.user.id,
    p_step_id: target.id,
    p_from_seq: fromSeq,
    p_to_seq: nextSeq,
  });
  if (moveError) {
    return auditFailed(moveError, 'The rail move could not be recorded, so it did not happen. Try again.');
  }

  return NextResponse.json({
    deal: { code: deal.code, currentStepSeq: nextSeq },
  });
}
