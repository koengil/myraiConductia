import { NextResponse } from 'next/server';
import { canManageCompanyMembers } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { TABLE } from '@/lib/constants/tables';

type RouteContext = { params: Promise<{ companyId: string; userId: string }> };

/**
 * Bulk revoke-by-adder. Removes every deal seat that `userId` granted
 * (deal_memberships.added_by = userId), scoped to the company's own deals
 * (deals.bank_id = companyId). Use when a director who sponsored external
 * members leaves: clean up the access they handed out. Director-gated; each
 * revoked seat is audited after the delete succeeds. Distinct from removing `userId` themselves.
 */
export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, userId } = await context.params;

  const allowed = await canManageCompanyMembers(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Only a company director can revoke grants', 403);

  const { data: deals, error: dealsError } = await auth.admin
    .from(TABLE.DEALS)
    .select('id')
    .eq('bank_id', companyId);
  if (dealsError) return jsonError(dealsError.message, 500);

  const dealIds = (deals ?? []).map((d) => d.id);
  if (dealIds.length === 0) return NextResponse.json({ revoked: 0 });

  const { data: seats, error: seatsError } = await auth.admin
    .from(TABLE.DEAL_MEMBERSHIPS)
    .select('id, deal_id, user_id')
    .eq('added_by', userId)
    .in('deal_id', dealIds);
  if (seatsError) return jsonError(seatsError.message, 500);
  if (!seats || seats.length === 0) return NextResponse.json({ revoked: 0 });

  const { error: delError } = await auth.admin
    .from(TABLE.DEAL_MEMBERSHIPS)
    .delete()
    .in(
      'id',
      seats.map((s) => s.id),
    );
  if (delError) return jsonError(delError.message, 500);

  const auditRows = seats.map((s) => ({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.REVOKE,
    deal_id: s.deal_id,
    detail: {
      reason: 'bulk_revoke_by_adder',
      granter: userId,
      removed_user: s.user_id,
      company_id: companyId,
    },
  }));
  const { error: auditError } = await auth.admin.from(TABLE.AUDIT_LOG).insert(auditRows);
  if (auditError) return jsonError(auditError.message, 500);

  return NextResponse.json({ revoked: seats.length });
}
