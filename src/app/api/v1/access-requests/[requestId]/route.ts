import { NextResponse } from 'next/server';

import {
  displayNameFor,
  grantRequestedPermission,
  isCompanyAccessAdmin,
  loadCallerProfile,
  serializeRequest,
  type AccessRequestRow,
} from '@/lib/api/v1/accessRequests';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import {
  ACCESS_DESTINATION_DEFS,
  ACCESS_REQUEST_STATUS,
} from '@/lib/constants/accessRequests';
import { isCompanyPermission } from '@/lib/constants/companyPermissions';
import { TABLE } from '@/lib/constants/tables';
import { notifyAccessDecision } from '@/lib/notifications/accessNotifications';

type RouteContext = { params: Promise<{ requestId: string }> };

function grantErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('stale_version')) {
    return jsonError('Employee access changed concurrently. Reload and retry.', 409);
  }
  if (message.includes('grant_outside_envelope')) {
    return jsonError('You can only grant permissions you already hold.', 403);
  }
  if (message.includes('not_permitted')) {
    return jsonError('You cannot assign employee access.', 403);
  }
  if (message.includes('company_member_not_eligible')) {
    return jsonError('This person cannot receive that access.', 409);
  }
  if (message.includes('protected_access_root')) {
    return jsonError('Protected company administrators have immutable access', 409);
  }
  if (message.includes('invalid_company_permission')) {
    return jsonError('Unknown permission on this request', 400);
  }
  return jsonError('Unable to grant access', 500);
}

/**
 * PATCH /api/v1/access-requests/{id} { decision: 'approved' | 'denied' }
 * Organization administrators decide in one click. Approve grants the mapped
 * company permission; both outcomes notify the requester.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { requestId } = await context.params;
  if (!isUuid(requestId)) return jsonError('Not found', 404);

  let body: { decision?: unknown };
  try {
    body = (await request.json()) as { decision?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (body.decision !== 'approved' && body.decision !== 'denied') {
    return jsonError('decision must be approved or denied', 400);
  }

  const profile = await loadCallerProfile(auth.admin, auth.user.id);
  if (!profile) return jsonError('User profile not found', 404);

  const { data: row, error: loadError } = await auth.admin
    .from(TABLE.ACCESS_REQUESTS)
    .select(
      'id, company_id, requester_id, destination, permission_key, status, decided_by, decided_at, created_at',
    )
    .eq('id', requestId)
    .maybeSingle();
  if (loadError) return jsonError(loadError.message, 500);
  if (!row) return jsonError('Not found', 404);

  const pending = row as AccessRequestRow;
  if (!(await isCompanyAccessAdmin(auth.admin, profile, pending.company_id))) {
    return jsonError('Forbidden', 403);
  }
  if (pending.status !== ACCESS_REQUEST_STATUS.PENDING) {
    return jsonError('This request has already been decided', 409);
  }
  if (pending.requester_id === auth.user.id) {
    return jsonError('You cannot decide your own request', 409);
  }

  const approved = body.decision === 'approved';
  if (approved) {
    const permission = isCompanyPermission(pending.permission_key)
      ? pending.permission_key
      : ACCESS_DESTINATION_DEFS[pending.destination].permission;
    try {
      await grantRequestedPermission(auth.admin, {
        actorId: auth.user.id,
        companyId: pending.company_id,
        userId: pending.requester_id,
        permission,
      });
    } catch (error) {
      return grantErrorResponse(error);
    }
  }

  const decidedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await auth.admin
    .from(TABLE.ACCESS_REQUESTS)
    .update({
      status: approved ? ACCESS_REQUEST_STATUS.APPROVED : ACCESS_REQUEST_STATUS.DENIED,
      decided_by: auth.user.id,
      decided_at: decidedAt,
    })
    .eq('id', requestId)
    .eq('status', ACCESS_REQUEST_STATUS.PENDING)
    .select(
      'id, company_id, requester_id, destination, permission_key, status, decided_by, decided_at, created_at',
    )
    .maybeSingle();
  if (updateError) return jsonError(updateError.message, 500);
  if (!updated) return jsonError('This request has already been decided', 409);

  const dest = ACCESS_DESTINATION_DEFS[pending.destination];
  const requester = await loadCallerProfile(auth.admin, pending.requester_id);
  try {
    await notifyAccessDecision(auth.admin, {
      tenantId: profile.tenant_id,
      recipientId: pending.requester_id,
      approved,
      actorName: displayNameFor(profile),
      destinationLabel: dest.label,
      href: dest.hrefFor(pending.company_id),
    });
  } catch {
    // Decision is persisted; the requester can refresh the destination.
  }

  return NextResponse.json({
    request: serializeRequest(
      updated as AccessRequestRow,
      requester ? displayNameFor(requester) : undefined,
    ),
  });
}
