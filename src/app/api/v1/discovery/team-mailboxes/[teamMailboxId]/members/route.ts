import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { addTeamMailboxMember } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ teamMailboxId: string }> };

/**
 * POST /api/v1/discovery/team-mailboxes/[teamMailboxId]/members: a firm admin lets a colleague read a team inbox
 * (#581). Body `{ userId }`. Runs under the caller's session; the RPC acts on auth.uid(), checks the caller is the
 * registration's own firm admin, takes the tenant's discovery lock and audits by ids. No admin client is built here.
 *
 * Behind `deal_discovery`, like connecting the inbox. `201 { member }` for a new member, `200 { member }` for a
 * person who already was one (no write, no audit). `422 not_eligible_member` for anyone who is not an active,
 * internal colleague seated in the firm who is not a firm admin, the caller included. One `404` for every refusal
 * the caller must not tell apart: no such inbox, another firm's, one already removed, or a caller who is not the
 * firm's admin. The membership grants nothing by itself: what a member sees is decided in SQL.
 * Removing a member is in ./[userId]/route.ts.
 */
export async function POST(request: Request, context: RouteContext) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const { teamMailboxId } = await context.params;
  if (!isUuid(teamMailboxId)) return jsonError('teamMailboxId must be a UUID', 400);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return jsonError('Invalid JSON body', 400);
  const { userId } = raw as Record<string, unknown>;
  if (typeof userId !== 'string' || !isUuid(userId)) return jsonError('userId must be a UUID', 400);

  const result = await addTeamMailboxMember(auth.db, teamMailboxId, userId);
  if (result.ok) return NextResponse.json({ member: result.member }, { status: result.created ? 201 : 200 });
  if (result.reason === 'not_available') return jsonError('Not found', 404);
  if (result.reason === 'not_eligible_member') return jsonError('not_eligible_member', 422);
  return jsonError('Could not add the person to the team inbox', 500);
}
