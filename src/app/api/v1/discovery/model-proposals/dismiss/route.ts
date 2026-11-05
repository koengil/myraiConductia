import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { dismissModelProposal, modelProposalDismissErrorStatus } from '@/lib/discovery/api';
import { DEAL_KEY_RX } from '@/lib/discovery/propose/key';
import { logServerEvent, type LineFor } from '@/lib/log';

export const dynamic = 'force-dynamic';

const badFields = () => jsonError(modelProposalDismissErrorStatus('22023').error, 400);

/**
 * POST /api/v1/discovery/model-proposals/dismiss: demo only, like the proposals (#460; removed when #459 lands).
 * The owner of the mailbox a proposal came from dismisses one deal's proposal rows as they stand now (G-02a,
 * #173). Body `{ dealKey }`, the group's key. Answers `{ dismissed, operationId }`: the dismissal rows written,
 * and the operation's id, a content-free reference the owner quotes to ask for a restore. `{ 0, null }` when every
 * row was already dismissed (a repeat, a second tab). 404 unless both deal_discovery and
 * discovery_model_proposals_demo are on, before authenticating.
 *
 * The RPC acts on the caller's own session and answers P0002 to anyone who is not the owner of a personal source
 * holding a live row of the key. The key is a slug of a mail-derived name: no answer or log line carries it, every
 * refusal is a fixed text, and only the SQLSTATE is logged, through the content-free server logger.
 */
export async function POST(request: Request) {
  const discovery = await requireFlag('deal_discovery');
  if (discovery) return discovery;
  const demo = await requireFlag('discovery_model_proposals_demo');
  if (demo) return demo;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badFields();
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return badFields();
  const dealKey = (body as Record<string, unknown>).dealKey;
  if (typeof dealKey !== 'string' || !DEAL_KEY_RX.test(dealKey)) return badFields();

  const result = await dismissModelProposal(auth.db, dealKey);
  if (result.ok) return NextResponse.json({ dismissed: result.dismissed, operationId: result.operationId });
  const { status, error } = modelProposalDismissErrorStatus(result.code);
  if (status === 500) {
    // The content-free logger (#697): the SQLSTATE only, from a closed set; never the database's message or the key.
    logServerEvent({
      evt: 'request_error',
      routeType: 'route',
      method: 'POST',
      errorClass: 'db',
      status: 500,
      sqlstate: result.code as LineFor<'request_error'>['sqlstate'],
    });
  }
  return jsonError(error, status);
}
