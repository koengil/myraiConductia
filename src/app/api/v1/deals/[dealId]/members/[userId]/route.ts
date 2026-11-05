import { NextResponse } from 'next/server';
import { canManageDealMembers, userCanAccessDeal, userIsDealMd } from '@/lib/api/v1/access';
import { auditFailed, jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { dealNotVisible, forbiddenOrNotVisible } from '@/lib/api/v1/dealNotVisible';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { DEAL_ROLE } from '@/lib/constants/roles';

type RouteContext = { params: Promise<{ dealId: string; userId: string }> };

/**
 * Remove a member from a single deal (S1) — distinct from removing them
 * from the company. The member keeps their company membership and any other
 * deal seats. Authority: whoever added the seat (added_by) while they can
 * still see the deal, the deal MD (or
 * firm admin), or an MD-delegated member (access_scope.can_manage_members).
 * A deal must retain at least one MD; removing the last MD is rejected.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam, userId } = await context.params;
  // Flag-off parity (spec c.16): pre-onboarding behavior used the raw route
  // segment; resolve human-readable deal codes only when the flag is on.
  let dealId = dealParam;
  if (await isFlagEnabled('platform_onboarding')) {
    const dealRef = await resolveDealRef(auth.admin, dealParam);
    if (!dealRef) return jsonError('Deal not found', 404);
    dealId = dealRef.id;
  }

  const { data: seat, error: seatError } = await auth.admin
    .from('deal_memberships')
    .select('id, added_by, deal_role')
    .eq('deal_id', dealId)
    .eq('user_id', userId)
    .maybeSingle();
  if (seatError) return jsonError(seatError.message, 500);
  if (!seat) {
    // No such seat must not tell an unseated caller that the deal exists.
    const visible =
      (await userCanAccessDeal(auth.admin, auth.user.id, dealId)) ||
      (await canManageDealMembers(auth.admin, auth.user.id, dealId));
    return visible ? jsonError('User is not a member of this deal', 404) : dealNotVisible();
  }

  // added_by is authority only while the adder can still see the deal: a
  // former adder whose own seat is gone must not remove anyone (D65).
  const canManage =
    (await canManageDealMembers(auth.admin, auth.user.id, dealId)) ||
    (seat.added_by === auth.user.id && (await userCanAccessDeal(auth.admin, auth.user.id, dealId)));
  if (!canManage) {
    return forbiddenOrNotVisible(
      auth.admin,
      auth.user.id,
      dealId,
      'Not allowed to remove members from this deal',
    );
  }

  if (seat.deal_role === DEAL_ROLE.MD) {
    const { data: mdSeats, error: mdCountError } = await auth.admin
      .from('deal_memberships')
      .select('id')
      .eq('deal_id', dealId)
      .eq('deal_role', DEAL_ROLE.MD);
    if (mdCountError) return jsonError(mdCountError.message, 500);
    if ((mdSeats?.length ?? 0) <= 1) {
      return jsonError('Deal must retain at least one managing director', 409);
    }
  }

  const { error: delError } = await auth.admin.from('deal_memberships').delete().eq('id', seat.id);
  if (delError) return jsonError(delError.message, 500);

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.REVOKE,
    deal_id: dealId,
    detail: { reason: 'deal_member_removed', removed_user: userId },
  });
  if (auditError) return auditFailed(auditError, 'The removal was saved, but its audit record could not be written. Contact compliance before retrying.');

  return NextResponse.json({ removed: { dealId, userId } });
}

/**
 * Delegate (or revoke) deal-member management to an existing seat by setting
 * access_scope.can_manage_members. Only the deal MD (or firm admin) can
 * delegate, so a delegate cannot re-delegate. Audited as 'grant'.
 *
 * With platform_onboarding on, the same PATCH also raises a seat's disclosure
 * `phase` (MD-only, monotonic — a phase is a released wall, never re-raised;
 * spec-v3 criterion 12). Equal-phase PATCHes are idempotent no-ops, so
 * team-wide fan-outs can be retried safely (cr-plan-v1 4.2).
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam, userId } = await context.params;
  // Flag-off parity (spec c.16): pre-onboarding behavior used the raw route
  // segment; resolve human-readable deal codes only when the flag is on.
  let dealId = dealParam;
  if (await isFlagEnabled('platform_onboarding')) {
    const dealRef = await resolveDealRef(auth.admin, dealParam);
    if (!dealRef) return jsonError('Deal not found', 404);
    dealId = dealRef.id;
  }

  if (!(await userIsDealMd(auth.admin, auth.user.id, dealId))) {
    return forbiddenOrNotVisible(
      auth.admin,
      auth.user.id,
      dealId,
      'Only the deal MD can change member access',
    );
  }

  let body: { canManageMembers?: boolean; phase?: number };
  try {
    body = (await request.json()) as { canManageMembers?: boolean; phase?: number };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const hasDelegation = typeof body.canManageMembers === 'boolean';
  const hasPhase = body.phase !== undefined;
  if (hasPhase && !(await isFlagEnabled('platform_onboarding'))) {
    // Flag-off parity: the phase field does not exist yet.
    return jsonError('canManageMembers (boolean) is required', 400);
  }
  if (!hasDelegation && !hasPhase) {
    return jsonError('canManageMembers (boolean) is required', 400);
  }
  if (hasPhase && (!Number.isInteger(body.phase) || (body.phase as number) < 0)) {
    return jsonError('phase must be a non-negative integer', 400);
  }

  const { data: seat, error: seatError } = await auth.admin
    .from('deal_memberships')
    .select('id, access_scope, phase')
    .eq('deal_id', dealId)
    .eq('user_id', userId)
    .maybeSingle();
  if (seatError) return jsonError(seatError.message, 500);
  if (!seat) return jsonError('User is not a member of this deal', 404);

  const updates: Record<string, unknown> = {};
  const auditRows: Array<Record<string, unknown>> = [];

  if (hasDelegation) {
    const existing = (seat.access_scope ?? {}) as Record<string, unknown>;
    updates.access_scope = { ...existing, can_manage_members: body.canManageMembers };
    auditRows.push({
      actor_id: auth.user.id,
      action: AUDIT_ACTION.GRANT,
      deal_id: dealId,
      detail: { reason: 'delegate_manage_members', user: userId, can_manage_members: body.canManageMembers },
    });
  }

  if (hasPhase) {
    const currentPhase = (seat.phase as number) ?? 0;
    const nextPhase = body.phase as number;
    if (nextPhase < currentPhase) {
      return jsonError('Phase can only be raised. Disclosure is monotonic.', 409);
    }
    if (nextPhase > currentPhase) {
      updates.phase = nextPhase;
      auditRows.push({
        actor_id: auth.user.id,
        action: AUDIT_ACTION.GRANT,
        deal_id: dealId,
        detail: { reason: 'phase_raised', user: userId, from: currentPhase, to: nextPhase },
      });
    }
    // nextPhase === currentPhase: idempotent no-op.
  }

  if (Object.keys(updates).length > 0) {
    const { error: updateError } = await auth.admin
      .from('deal_memberships')
      .update(updates)
      .eq('id', seat.id);
    if (updateError) return jsonError(updateError.message, 500);
  }
  if (auditRows.length > 0) {
    const { error: auditError } = await auth.admin.from('audit_log').insert(auditRows);
    if (auditError) return jsonError(auditError.message, 500);
  }

  return NextResponse.json({
    updated: {
      dealId,
      userId,
      ...(hasDelegation ? { canManageMembers: body.canManageMembers } : {}),
      ...(hasPhase ? { phase: body.phase } : {}),
    },
  });
}
