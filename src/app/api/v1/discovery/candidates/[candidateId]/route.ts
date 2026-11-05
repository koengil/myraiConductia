import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { getCandidateDetail } from '@/lib/discovery/api';
import { logServerEvent, type LineFor } from '@/lib/log';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/discovery/candidates/{candidateId}: one proposed deal with its
 * suggested step, milestones and cited evidence. Read under RLS with the
 * caller's own session (requireApiUserScoped): a candidate the caller cannot
 * see is the same 404 as one that does not exist, and a colleague's mail comes
 * back as metadata, never text.
 */
export async function GET(_req: Request, context: { params: Promise<{ candidateId: string }> }) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const { candidateId } = await context.params;
  if (!isUuid(candidateId)) return jsonError('Proposed deal not found', 404);

  const result = await getCandidateDetail(auth.db, auth.user.id, candidateId);
  if (!result.ok) {
    // The cause, as a code only: the message can quote the request.
    logServerEvent({
      evt: 'request_error',
      routeType: 'route',
      method: 'GET',
      errorClass: 'db',
      status: 500,
      sqlstate: result.code as LineFor<'request_error'>['sqlstate'],
    });
    return jsonError('Could not load the proposed deal', 500);
  }
  if (!result.detail) return jsonError('Proposed deal not found', 404);
  return NextResponse.json({ candidate: result.detail });
}
