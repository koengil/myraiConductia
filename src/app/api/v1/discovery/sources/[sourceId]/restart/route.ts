import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { restartMailboxSource } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sourceId: string }> };

/**
 * POST /api/v1/discovery/sources/[sourceId]/restart: a firm admin restarts a halted
 * mailbox source (reader liveness, epic #261). A source halts when its history window
 * is exceeded and a reset would only repeat; the worker then neither queues nor reads
 * it. The restart clears the halt and the stored cursor, so the next tick reads the
 * mailbox again from the start (dedupe drops what is already stored). Halted sources
 * only, any provider; a paused source stays paused. Not behind `deal_discovery`: a
 * recovery control is always reachable. The RPC checks the caller is the source's own
 * firm admin, and answers "not visible" for every other case (404): no such source,
 * another tenant's, an archived one, one that is not halted, one restarted in the
 * last 24 hours (a restart re-reads the whole mailbox), or a caller who is not the
 * firm's admin.
 */
export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const { sourceId } = await context.params;
  if (!isUuid(sourceId)) return jsonError('sourceId must be a UUID', 400);

  const result = await restartMailboxSource(auth.db, sourceId);
  if (result.ok) return NextResponse.json({ id: result.id, restarted: true });
  if (result.reason === 'not_available') return jsonError('Not found', 404);
  return jsonError('Could not restart the source', 500);
}
