import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { setMailboxSourceStatus } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sourceId: string }> };

/**
 * PATCH /api/v1/discovery/sources/[sourceId]/status: a firm admin pauses or
 * resumes a Google mailbox source (#259, phase 4; R12, review after the fact).
 * Pausing never deletes: the worker reads active sources only, and what was
 * read stays. Not behind `deal_discovery`, like withdrawal: a control that stops
 * reading is always reachable. The RPC checks the caller is the source's own
 * firm admin, and answers "not visible" for every other case (404).
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const { sourceId } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const status = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
  if (!isUuid(sourceId) || (status !== 'active' && status !== 'paused')) {
    return jsonError('status must be active or paused', 400);
  }

  const result = await setMailboxSourceStatus(auth.db, sourceId, status);
  if (result.ok) return NextResponse.json({ id: result.id, status: result.status, changed: result.changed });
  if (result.reason === 'not_available') return jsonError('Not found', 404);
  if (result.reason === 'invalid') return jsonError('status must be active or paused', 400);
  return jsonError('Could not change the source status', 500);
}
