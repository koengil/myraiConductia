import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canManageCompanyMembers } from '@/lib/api/v1/access';
import { getCompanyEffectivePermissionsChecked } from '@/lib/api/v1/companyAccess';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import {
  COMPANY_PERMISSION,
  isCompanyPermission,
} from '@/lib/constants/companyPermissions';
import {
  DEPARTMENT,
  resolvePreferredDealRole,
} from '@/lib/constants/roles';
import { USER_STATUS } from '@/lib/constants/users';

type RouteContext = { params: Promise<{ companyId: string; userId: string }> };

const MEMBER_COLUMNS =
  'id, email, company_id, company_role, can_invite, preferred_deal_role, department, is_external';

async function updateLegacyInviteGrant(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
  userId: string,
  member: Record<string, unknown>,
  enabled: boolean,
) {
  const [accessResult, rolesResult, directResult] = await Promise.all([
    admin
      .from('company_member_access')
      .select('version')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle(),
    admin
      .from('company_member_roles')
      .select('role_id')
      .eq('company_id', companyId)
      .eq('user_id', userId),
    admin
      .from('company_member_permissions')
      .select('permission_key')
      .eq('company_id', companyId)
      .eq('user_id', userId),
  ]);
  if (accessResult.error || rolesResult.error || directResult.error) {
    return jsonError('Company access is unavailable', 503);
  }

  const roleIds = ((rolesResult.data ?? []) as Array<{ role_id: unknown }>).map(
    (row) => row.role_id,
  );
  const directPermissions = ((directResult.data ?? []) as Array<{ permission_key: unknown }>).map(
    (row) => row.permission_key,
  );
  if (
    !roleIds.every((roleId) => typeof roleId === 'string') ||
    !directPermissions.every(isCompanyPermission)
  ) {
    return jsonError('Company access is unavailable', 503);
  }

  const nextDirectPermissions = enabled
    ? [...new Set([...directPermissions, COMPANY_PERMISSION.INVITES_SEND])]
    : directPermissions.filter((permission) => permission !== COMPANY_PERMISSION.INVITES_SEND);
  const directGrantChanged = nextDirectPermissions.length !== directPermissions.length;

  if (directGrantChanged) {
    const { error } = await admin.rpc('replace_company_member_access', {
      p_actor_id: actorId,
      p_company_id: companyId,
      p_user_id: userId,
      p_expected_version: Number(accessResult.data?.version ?? 0),
      p_role_ids: roleIds as string[],
      p_direct_permission_keys: nextDirectPermissions,
    });
    if (error) {
      if (error.message.includes('stale_version')) {
        return jsonError('Employee access changed concurrently. Reload and retry.', 409);
      }
      if (error.message.includes('protected_access_root')) {
        return jsonError('Protected company administrators have immutable access', 409);
      }
      if (
        error.message.includes('grant_outside_envelope') ||
        error.message.includes('grant_envelope_exceeded') ||
        error.message.includes('not_permitted')
      ) {
        return jsonError('Forbidden', 403);
      }
      if (error.message.includes('member_not_eligible')) {
        return jsonError('User is not an eligible company member', 404);
      }
      return jsonError('Unable to update company access', 500);
    }
  }

  const effective = await getCompanyEffectivePermissionsChecked(admin, userId, companyId);
  if (effective === 'unreadable') return jsonError('Company access is unavailable', 503);
  const inviteSources = effective.filter(
    (permission) => permission.permissionKey === COMPANY_PERMISSION.INVITES_SEND,
  );

  return NextResponse.json({
    member: { ...member, can_invite: inviteSources.length > 0 },
    invite_permission: {
      effective: inviteSources.length > 0,
      direct: nextDirectPermissions.includes(COMPANY_PERMISSION.INVITES_SEND),
      sources: inviteSources,
    },
  });
}

/**
 * Remove a member from a company (S2 / D32). Director-gated; cannot
 * remove yourself (S3). Clears company_id first (the DB cascade drops deal
 * seats), then audits each revoked seat only after the removal succeeds. The
 * DB >=1-director trigger rejects removing the last director while members remain.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, userId } = await context.params;

  // S3 — no self-removal.
  if (userId === auth.user.id) {
    return jsonError('You cannot remove yourself from the company', 403);
  }

  const allowed = await canManageCompanyMembers(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Only a company director can remove members', 403);

  const { data: target, error: targetError } = await auth.admin
    .from('users')
    .select('id, company_id')
    .eq('id', userId)
    .maybeSingle();
  if (targetError) return jsonError(targetError.message, 500);
  if (!target || target.company_id !== companyId) {
    return jsonError('User is not a member of this company', 404);
  }

  const { data: seats, error: seatsError } = await auth.admin
    .from('deal_memberships')
    .select('deal_id')
    .eq('user_id', userId);
  if (seatsError) return jsonError(seatsError.message, 500);

  // Clear company membership (cascade drops the seats) and lock the account.
  const { error: removeError } = await auth.admin
    .from('users')
    .update({
      company_id: null,
      company_role: null,
      status: USER_STATUS.SUSPENDED,
      can_invite: false,
      // The preference is company-managed; a later employer must not inherit it.
      preferred_deal_role: null,
    })
    .eq('id', userId);
  if (removeError) {
    // Most likely the >=1-director invariant (last director while members remain).
    return jsonError(removeError.message, 409);
  }

  if (seats && seats.length > 0) {
    const auditRows = seats.map((s) => ({
      actor_id: auth.user.id,
      action: AUDIT_ACTION.REVOKE,
      deal_id: s.deal_id,
      detail: { reason: 'company_removal', removed_user: userId, company_id: companyId },
    }));
    const { error: auditError } = await auth.admin.from('audit_log').insert(auditRows);
    if (auditError) return jsonError(auditError.message, 500);
  }

  return NextResponse.json({
    removed: { userId, companyId, seatsRevoked: seats?.length ?? 0 },
  });
}

/**
 * Update one company-member setting with a CAS write and audited rollback.
 * canInvite (Aug 4 sync, Roberto) lets a member invite into their own company
 * (userCanInvite) without director rights; it never extends to resend/revoke
 * or deal seats. preferredDealRole (#160 Phase A) is a proposal-only prefill;
 * it grants nothing and never touches deal memberships.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId, userId } = await context.params;

  const allowed = await canManageCompanyMembers(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Only a company director can change member settings', 403);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return jsonError('JSON body must be an object', 400);
  }
  const body = rawBody as { canInvite?: boolean; preferredDealRole?: string | null };

  // Keep each request single-field: the CAS, audit row, and rollback below
  // describe exactly one setting change.
  const fields = (['canInvite', 'preferredDealRole'] as const).filter((key) => key in body);
  if (fields.length !== 1 || Object.keys(body).length !== 1) {
    return jsonError('Send exactly one of canInvite or preferredDealRole', 400);
  }
  const field = fields[0];

  if (field === 'canInvite' && typeof body.canInvite !== 'boolean') {
    return jsonError('canInvite must be a boolean', 400);
  }
  if (field === 'preferredDealRole') {
    if (!(await isFlagEnabled('platform_onboarding'))) {
      return jsonError('preferredDealRole is not available', 400);
    }
    if (body.preferredDealRole !== null && !resolvePreferredDealRole(body.preferredDealRole)) {
      return jsonError('preferredDealRole must be deal_team, legal, read_only, or null', 400);
    }
  }

  // Read the real previous value first: the rollback below must restore it,
  // and an idempotent request short-circuits without an audit entry.
  const { data: before, error: beforeError } = await auth.admin
    .from('users')
    .select(MEMBER_COLUMNS)
    .eq('id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (beforeError) return jsonError(beforeError.message, 500);
  if (!before) return jsonError('User is not a member of this company', 404);

  if (field === 'preferredDealRole') {
    const walled =
      before.department === DEPARTMENT.RESEARCH || before.department === DEPARTMENT.TRADING;
    if (before.is_external || walled) {
      return jsonError('Preferred roles apply to internal, non-walled members only', 403);
    }
  }

  // Compatibility contract for one release. The Phase B migration makes the
  // permission model authoritative regardless of UI rollout state, so this
  // legacy boolean must always mutate the direct invites permission through
  // the same transaction. Otherwise flag-off grants are inert and revocations
  // can leave a backfilled permission active.
  if (field === 'canInvite') {
    return updateLegacyInviteGrant(
      auth.admin,
      auth.user.id,
      companyId,
      userId,
      before as Record<string, unknown>,
      body.canInvite!,
    );
  }

  const column = 'preferred_deal_role';
  const nextValue = body.preferredDealRole ?? null;
  const beforeValue = before[column];
  if (beforeValue === nextValue) {
    return NextResponse.json({ member: before });
  }

  // Compare-and-swap on the value just read: a concurrent change makes this
  // match zero rows instead of silently overwriting it.
  let updateQuery = auth.admin
    .from('users')
    .update({ [column]: nextValue })
    .eq('id', userId)
    .eq('company_id', companyId);
  updateQuery = beforeValue === null
    ? updateQuery.is(column, null)
    : updateQuery.eq(column, beforeValue);
  const { data: member, error } = await updateQuery
    .select(MEMBER_COLUMNS)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!member) {
    return jsonError('The member setting changed concurrently. Reload and retry.', 409);
  }

  const detail = {
    reason: 'company_preferred_deal_role_changed',
    user: userId,
    company_id: companyId,
    old_preferred_deal_role: beforeValue,
    new_preferred_deal_role: nextValue,
  };
  const granted = nextValue !== null;
  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: granted ? AUDIT_ACTION.GRANT : AUDIT_ACTION.REVOKE,
    detail,
  });
  if (auditError) {
    // No unrecorded permission change: restore the actual previous value,
    // but only over our own write (a concurrent success is never undone).
    // Durable fix is a transactional RPC; tracked for the RLS/hardening pass.
    let restoreQuery = auth.admin
      .from('users')
      .update({ [column]: beforeValue })
      .eq('id', userId)
      .eq('company_id', companyId);
    restoreQuery = nextValue === null
      ? restoreQuery.is(column, null)
      : restoreQuery.eq(column, nextValue);
    const { error: restoreError } = await restoreQuery;
    if (restoreError) {
      return jsonError(
        'Unable to record the change and the setting was not restored. Retry.',
        500,
      );
    }
    return jsonError('Unable to record the change. Try again.', 500);
  }

  return NextResponse.json({ member });
}
