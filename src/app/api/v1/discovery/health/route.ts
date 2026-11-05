import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { readIngestionHealth } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/discovery/health: the ingestion health of the caller's tenant.
 * For a firm admin, who runs the connector, and the control room (cco): each
 * content source's sync state, last error and counts, never text, subjects,
 * participants or parties (Q19). Everyone else gets the same 404 as when the
 * flag is off. Read with the caller's own session; the security definer RPC
 * decides from auth.uid().
 */
export async function GET() {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const result = await readIngestionHealth(auth.db);
  if (!result.ok) {
    return result.error === 'not_visible' ? jsonError('Not found', 404) : jsonError('Could not load ingestion health', 500);
  }
  return NextResponse.json({ health: result.health });
}
