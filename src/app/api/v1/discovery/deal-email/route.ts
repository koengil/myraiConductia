import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { listDealEmail } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

const MAX_CODE_LENGTH = 64;

/**
 * GET /api/v1/discovery/deal-email?deal=<code>: the email discovery linked to a
 * promoted deal, for the Deal Folder's Deal email view. Read under RLS with the
 * caller's own session: a deal the caller is not seated on, or one with no
 * linked mail they may read, answers `{ items: [], truncated: false }`. Rows are
 * redacted here, not in the UI: a colleague's message carries its day and the
 * sender's domain only. No body is read or returned.
 */
export async function GET(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const deal = new URL(request.url).searchParams.get('deal')?.trim() ?? '';
  if (!deal || deal.length > MAX_CODE_LENGTH) return jsonError('deal is required', 400);

  const result = await listDealEmail(auth.db, deal);
  if (!result.ok) return jsonError('Could not load the deal email', 500);
  return NextResponse.json({ items: result.items, truncated: result.truncated });
}
