import { isUuid } from '@/lib/api/v1/http';
import { mergeCandidates } from '@/lib/discovery/api';
import {
  MAX_REASON_LENGTH,
  badFields,
  correctionResponse,
  readCorrectionRequest,
  text,
} from '@/lib/discovery/correctionRoute';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/discovery/candidates/{candidateId}/merge: merge this proposed
 * deal into another (the survivor). Body `{ survivorId, reason }`, both required.
 * The survivor gains this deal's evidence, keeps its own name, and a re-run lands
 * this deal's new mail on it. The RPC acts on the caller's own session and checks
 * deal-create authority.
 */
export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }) {
  const req = await readCorrectionRequest(request, context);
  if (!req.ok) return req.response;
  const survivorId = typeof req.body.survivorId === 'string' ? req.body.survivorId : null;
  const reason = text(req.body.reason, MAX_REASON_LENGTH);
  if (!survivorId || !isUuid(survivorId) || !reason) return badFields();
  return correctionResponse(await mergeCandidates(req.db, req.candidateId, survivorId, reason));
}
