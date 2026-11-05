import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { acceptModelProposal, modelProposalAcceptErrorStatus } from '@/lib/discovery/api';
import { MODEL_DEAL_KEY_RX, PROPOSED_STEP_ID_RX } from '@/lib/discovery/propose/key';
import { logServerEvent, type LineFor } from '@/lib/log';

export const dynamic = 'force-dynamic';

const badFields = () => jsonError(modelProposalAcceptErrorStatus('22023').error, 400);

/**
 * POST /api/v1/discovery/model-proposals/accept: demo only, like the proposals (#460; removed when #459 lands).
 * The owner of the mailbox an `m:` proposal came from accepts it as a proposed deal (G-02b, #173). Body
 * `{ dealKey, proposedStepId }`: the group's key and the station the list showed for it. Answers 202
 * `{ operationId, requestCount }`: the content-free reference of the request, and how many were recorded now (0, with
 * the same reference, for a repeat or a second tab). The request is only recorded: each source's next SYNC job reads
 * the emails again through the guard, so the answer says nothing about what it will find. 404 unless both
 * deal_discovery and discovery_model_proposals_demo are on, before authenticating.
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
  const { dealKey, proposedStepId } = body as Record<string, unknown>;
  if (typeof dealKey !== 'string' || !MODEL_DEAL_KEY_RX.test(dealKey)) return badFields();
  if (typeof proposedStepId !== 'string' || !PROPOSED_STEP_ID_RX.test(proposedStepId)) return badFields();

  const result = await acceptModelProposal(auth.db, dealKey, proposedStepId);
  if (result.ok) {
    return NextResponse.json({ operationId: result.operationId, requestCount: result.requestCount }, { status: 202 });
  }
  const { status, error, code } = modelProposalAcceptErrorStatus(result.code);
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
  return NextResponse.json(code ? { error, code } : { error }, { status });
}
