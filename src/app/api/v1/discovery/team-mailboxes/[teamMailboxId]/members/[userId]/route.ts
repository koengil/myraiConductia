import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { removeTeamMailboxMember } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ teamMailboxId: string; userId: string }> };

/**
 * DELETE /api/v1/discovery/team-mailboxes/[teamMailboxId]/members/[userId]: a firm admin takes a person off a team
 * inbox (#581). The membership row is closed, never deleted, and the person's deals and deal memberships are not
 * touched. `204` whether or not the person was a member (removing is idempotent). Not behind `deal_discovery`: a way
 * to stop someone reading is always reachable, like Remove and withdrawal. One `404` for every refusal the caller
 * must not tell apart: no such inbox, another firm's, one already removed, or a caller who is not the firm's admin.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const { teamMailboxId, userId } = await context.params;
  if (!isUuid(teamMailboxId)) return jsonError('teamMailboxId must be a UUID', 400);
  if (!isUuid(userId)) return jsonError('userId must be a UUID', 400);

  const result = await removeTeamMailboxMember(auth.db, teamMailboxId, userId);
  if (result.ok) return new NextResponse(null, { status: 204 });
  if (result.reason === 'not_available') return jsonError('Not found', 404);
  return jsonError('Could not remove the person from the team inbox', 500);
}
