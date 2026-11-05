import { NextResponse } from 'next/server';

import {
  displayNameFor,
  isCompanyAccessAdmin,
  listApproverIds,
  loadCallerProfile,
  serializeRequest,
  type AccessRequestRow,
} from '@/lib/api/v1/accessRequests';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import {
  ACCESS_DESTINATION_DEFS,
  ACCESS_REQUEST_STATUS,
  approverInboxHref,
  isAccessDestination,
} from '@/lib/constants/accessRequests';
import { TABLE } from '@/lib/constants/tables';
import { notifyAccessRequested } from '@/lib/notifications/accessNotifications';

/**
 * GET /api/v1/access-requests — the caller's own requests, plus the company
 * inbox when they can approve.
 * POST /api/v1/access-requests { destination } — ask an org admin for access.
 */
export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const profile = await loadCallerProfile(auth.admin, auth.user.id);
  if (!profile) return jsonError('User profile not found', 404);

  const { data: mineRaw, error: mineError } = await auth.admin
    .from(TABLE.ACCESS_REQUESTS)
    .select(
      'id, company_id, requester_id, destination, permission_key, status, decided_by, decided_at, created_at',
    )
    .eq('requester_id', auth.user.id)
    .order('created_at', { ascending: false });
  if (mineError) return jsonError(mineError.message, 500);

  const mine = ((mineRaw ?? []) as AccessRequestRow[]).map((row) => serializeRequest(row));

  let inbox: ReturnType<typeof serializeRequest>[] = [];
  if (profile.company_id && (await isCompanyAccessAdmin(auth.admin, profile, profile.company_id))) {
    const { data: inboxRaw, error: inboxError } = await auth.admin
      .from(TABLE.ACCESS_REQUESTS)
      .select(
        'id, company_id, requester_id, destination, permission_key, status, decided_by, decided_at, created_at',
      )
      .eq('company_id', profile.company_id)
      .eq('status', ACCESS_REQUEST_STATUS.PENDING)
      .order('created_at', { ascending: true });
    if (inboxError) return jsonError(inboxError.message, 500);

    const rows = (inboxRaw ?? []) as AccessRequestRow[];
    const requesterIds = [...new Set(rows.map((row) => row.requester_id))];
    const names = new Map<string, string>();
    if (requesterIds.length > 0) {
      const { data: people, error: peopleError } = await auth.admin
        .from(TABLE.USERS)
        .select('id, display_name, full_name')
        .in('id', requesterIds);
      if (peopleError) return jsonError(peopleError.message, 500);
      for (const person of people ?? []) {
        names.set(person.id as string, displayNameFor(person as { display_name: string | null; full_name: string }));
      }
    }
    inbox = rows.map((row) => serializeRequest(row, names.get(row.requester_id)));
  }

  return NextResponse.json({ mine, inbox });
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: { destination?: unknown };
  try {
    body = (await request.json()) as { destination?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!isAccessDestination(body.destination)) {
    return jsonError('Unknown access destination', 400);
  }

  const profile = await loadCallerProfile(auth.admin, auth.user.id);
  if (!profile) return jsonError('User profile not found', 404);
  if (!profile.company_id) {
    return jsonError('Join an organization before requesting access', 409);
  }

  const dest = ACCESS_DESTINATION_DEFS[body.destination];
  const { data: existing, error: existingError } = await auth.admin
    .from(TABLE.ACCESS_REQUESTS)
    .select(
      'id, company_id, requester_id, destination, permission_key, status, decided_by, decided_at, created_at',
    )
    .eq('company_id', profile.company_id)
    .eq('requester_id', auth.user.id)
    .eq('destination', dest.id)
    .eq('status', ACCESS_REQUEST_STATUS.PENDING)
    .maybeSingle();
  if (existingError) return jsonError(existingError.message, 500);
  if (existing) {
    return NextResponse.json({ request: serializeRequest(existing as AccessRequestRow) });
  }

  const { data: created, error: createError } = await auth.admin
    .from(TABLE.ACCESS_REQUESTS)
    .insert({
      company_id: profile.company_id,
      requester_id: auth.user.id,
      destination: dest.id,
      permission_key: dest.permission,
      status: ACCESS_REQUEST_STATUS.PENDING,
    })
    .select(
      'id, company_id, requester_id, destination, permission_key, status, decided_by, decided_at, created_at',
    )
    .single();
  if (createError) return jsonError(createError.message, 500);

  const approverIds = (await listApproverIds(auth.admin, profile.company_id)).filter(
    (id) => id !== auth.user.id,
  );
  if (approverIds.length > 0) {
    try {
      await notifyAccessRequested(auth.admin, {
        tenantId: profile.tenant_id,
        approverIds,
        requesterName: displayNameFor(profile),
        destinationLabel: dest.label,
        href: approverInboxHref(profile.company_id),
        requestId: (created as AccessRequestRow).id,
        companyId: profile.company_id,
      });
    } catch {
      // The request is already stored; the inbox still surfaces it.
    }
  }

  return NextResponse.json({ request: serializeRequest(created as AccessRequestRow) }, { status: 201 });
}
