import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { listModelProposals } from '@/lib/discovery/propose/read';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/discovery/model-proposals: demo only (#460; removed when #459
 * lands). The deals a model proposed from mail the codename rules did not
 * route, grouped by deal, read under RLS with the caller's own session: the
 * owner of the mailbox a message came from sees it, nobody else does. 404
 * unless both deal_discovery and discovery_model_proposals_demo are on, before
 * authenticating.
 *
 * Rows the caller dismissed are left out (G-02a, #173), and `dismissedCount` says how many deals have dismissed
 * rows, so nothing disappears without a trace. A `c:` group carries `promoted` when its candidate is a mandate, and
 * every group carries `actionable`: true only when all its rows are on a personal mailbox the caller owns. An
 * actionable `m:` group also carries `proposed` (the station the model proposes, and how many of its emails it placed
 * in that phase) and `accept` (pending or failed, G-02b #173); every other group carries both as null.
 */
export async function GET() {
  const discovery = await requireFlag('deal_discovery');
  if (discovery) return discovery;
  const demo = await requireFlag('discovery_model_proposals_demo');
  if (demo) return demo;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const result = await listModelProposals(auth.db, { userId: auth.user.id });
  if (!result.ok) return jsonError('Could not load model proposals', 500);
  return NextResponse.json({ proposals: result.proposals, dismissedCount: result.dismissedCount });
}
