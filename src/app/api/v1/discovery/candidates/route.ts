import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { listCandidates } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/discovery/candidates: the proposed deals the caller can see.
 * Read under RLS with the caller's own session (requireApiUserScoped): a
 * banker sees the candidates their own mail is evidence for, the control room
 * (cco) sees every candidate in its tenant, and anyone else sees none.
 */
export async function GET() {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const result = await listCandidates(auth.db, auth.user.id);
  if (!result.ok) return jsonError('Could not load proposed deals', 500);
  return NextResponse.json({ candidates: result.candidates });
}
