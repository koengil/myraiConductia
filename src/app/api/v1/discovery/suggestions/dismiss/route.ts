import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { dismissErrorStatus, dismissSuggestion, findDealIdByCode } from '@/lib/discovery/api';
import { MAX_REASON_LENGTH, text } from '@/lib/discovery/correctionRoute';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/discovery/suggestions/dismiss: the MD hides the rail's marker for
 * one assessment, with a reason. Body `{ dealCode, assessmentId, reason }`. The
 * RPC acts on the caller's own session and answers 42501 to anyone who is not
 * the deal's MD; a newer assessment shows the marker again.
 */
export async function POST(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;

  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(dismissErrorStatus('22023').error, 400);
  }
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const dealCode = text(fields.dealCode, 64);
  const reason = text(fields.reason, MAX_REASON_LENGTH);
  const assessmentId = typeof fields.assessmentId === 'string' ? fields.assessmentId : '';
  if (!dealCode || !isUuid(assessmentId)) return jsonError('dealCode and assessmentId are required', 400);
  if (!reason) return jsonError(dismissErrorStatus('22023').error, 400);

  const deal = await findDealIdByCode(auth.db, dealCode);
  if (!deal.ok) return jsonError(dismissErrorStatus().error, 500);
  if (!deal.dealId) return jsonError(dismissErrorStatus('P0002').error, 404);

  const result = await dismissSuggestion(auth.db, deal.dealId, assessmentId, reason);
  if (!result.ok) {
    const { status, error } = dismissErrorStatus(result.code);
    return jsonError(error, status);
  }
  return NextResponse.json({ correctionId: result.correctionId });
}
