import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { setMailboxSourceWindow } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ sourceId: string }> };

/** A real calendar date written 'YYYY-MM-DD' (so '2026-02-30' is not one). */
function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * PUT /api/v1/discovery/sources/[sourceId]/window: a firm admin sets how far back a
 * Gmail mailbox's first read goes (#353; owner decision 2026-10-16). Body
 * `{ since: 'YYYY-MM-DD' }`, a UTC date no later than today and no earlier than 730
 * days before it. Only before the first read: once reading has started the window is
 * fixed (409 window_locked); a restart opens it again. Every real change is audited
 * in the RPC. Behind `deal_discovery`, unlike pause and restart: it widens reading
 * rather than stopping it. The RPC checks the caller is the source's own firm admin,
 * and answers "not visible" for every other case (404): no such source, another
 * tenant's, an archived one, a Microsoft one, or a caller who is not the firm's admin.
 */
export async function PUT(request: Request, context: RouteContext) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const { sourceId } = await context.params;
  if (!isUuid(sourceId)) return jsonError('sourceId must be a UUID', 400);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  const since = typeof body === 'object' && body !== null ? (body as { since?: unknown }).since : undefined;
  if (!isCalendarDate(since)) return jsonError('since must be a date, YYYY-MM-DD', 400);

  const result = await setMailboxSourceWindow(auth.db, sourceId, since);
  if (result.ok) return NextResponse.json({ id: result.id, backfillSince: result.backfillSince, changed: result.changed });
  if (result.reason === 'not_available') return jsonError('Not found', 404);
  if (result.reason === 'out_of_range') return jsonError('out_of_range', 400);
  if (result.reason === 'window_locked') return jsonError('window_locked', 409);
  return jsonError('Could not set the window', 500);
}
