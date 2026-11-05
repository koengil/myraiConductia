import { rejectCandidate } from '@/lib/discovery/api';
import {
  MAX_REASON_LENGTH,
  badFields,
  correctionResponse,
  readCorrectionRequest,
  text,
} from '@/lib/discovery/correctionRoute';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/discovery/candidates/{candidateId}/reject: take a proposed deal
 * off the list. Body `{ reason }`, required. The candidate and its evidence stay;
 * it gains nothing further. The RPC acts on the caller's own session and checks
 * deal-create authority.
 */
export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }) {
  const req = await readCorrectionRequest(request, context);
  if (!req.ok) return req.response;
  const reason = text(req.body.reason, MAX_REASON_LENGTH);
  if (!reason) return badFields();
  return correctionResponse(await rejectCandidate(req.db, req.candidateId, reason));
}
