import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { removeTeamMailbox } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ teamMailboxId: string }> };

/**
 * DELETE /api/v1/discovery/team-mailboxes/[teamMailboxId]: a firm admin removes a team inbox
 * whose source holds no mail (#581), verified or not, for example a deals@ that turned out to
 * be a group, or a typo. The registration is closed and its source archived. One that holds
 * mail answers 409 not_removable: disconnecting one with mail is a later slice. Not behind `deal_discovery`: a way out is always reachable, like withdrawal. The
 * RPC checks the caller is the registration's own firm admin and answers "not visible" for every
 * other case (404): no such registration, another firm's, one already closed, or a caller who
 * is not the firm's admin.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const { teamMailboxId } = await context.params;
  if (!isUuid(teamMailboxId)) return jsonError('teamMailboxId must be a UUID', 400);

  const result = await removeTeamMailbox(auth.db, teamMailboxId);
  if (result.ok) return new NextResponse(null, { status: 204 });
  if (result.reason === 'not_available') return jsonError('Not found', 404);
  if (result.reason === 'not_removable') return jsonError('not_removable', 409);
  return jsonError('Could not remove the team inbox', 500);
}
