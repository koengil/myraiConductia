import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { getEvidenceSuggestion } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

const MAX_CODE_LENGTH = 64;

/**
 * GET /api/v1/discovery/suggestions?deal=<code>: what the evidence says about a
 * promoted deal's step, for the rail's marker. Read under RLS with the
 * caller's own session: a member or overseer of the deal reads its latest
 * assessment, anyone else gets `{ suggestion: null, origin: 'rules' }`. The
 * response carries a step id, a templated reason and counts, never a message.
 * `origin` says whether the model found the deal ('model_proposal') or the
 * rules did ('rules'); the marker offers no one-click Move on the former. The
 * cluster key behind it never leaves the server. The origin is read past RLS
 * (discovery_deal_origin), so a member or overseer who is not the finder gets
 * the same answer; a failed origin read is a 500, never 'rules'.
 */
export async function GET(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const deal = new URL(request.url).searchParams.get('deal')?.trim() ?? '';
  if (!deal || deal.length > MAX_CODE_LENGTH) return jsonError('deal is required', 400);

  const result = await getEvidenceSuggestion(auth.db, deal);
  if (!result.ok) return jsonError('Could not load the suggestion', 500);
  return NextResponse.json({ suggestion: result.suggestion, origin: result.origin });
}
