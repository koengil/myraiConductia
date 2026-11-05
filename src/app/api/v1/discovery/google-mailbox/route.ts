import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { readGoogleMailboxStatus } from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/discovery/google-mailbox: what the /profile card shows a Gmail
 * member after "Connect my mailbox" (#259, phase 4). Opting in is
 * /discovery/mailbox-consent (#262), which creates the Google source; this
 * reports the caller's own Google mailbox: the ingest group the member must be
 * in, whether a firm admin paused it, and whether the guard is refusing it until
 * the member is in the group. It runs under the caller's session behind `deal_discovery`; the RPC acts
 * on auth.uid() only and returns no mail. No admin client is built here.
 */
export async function GET() {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;
  const result = await readGoogleMailboxStatus(auth.db);
  if (!result.ok) return jsonError('Could not load Gmail status', 500);
  return NextResponse.json(result.status);
}
