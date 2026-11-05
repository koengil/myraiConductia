import { isUuid } from '@/lib/api/v1/http';
import { reassignLink } from '@/lib/discovery/api';
import {
  MAX_REASON_LENGTH,
  badFields,
  correctionResponse,
  readCorrectionRequest,
  text,
} from '@/lib/discovery/correctionRoute';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/discovery/candidates/{candidateId}/reassign: move one email's
 * link from this proposed deal to another. Body `{ linkId, targetCandidateId,
 * reason }`, all required. A re-run leaves the email where the MD put it. The
 * RPC acts on the caller's own session and checks deal-create authority.
 */
export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }) {
  const req = await readCorrectionRequest(request, context);
  if (!req.ok) return req.response;
  const linkId = typeof req.body.linkId === 'string' ? req.body.linkId : null;
  const target = typeof req.body.targetCandidateId === 'string' ? req.body.targetCandidateId : null;
  const reason = text(req.body.reason, MAX_REASON_LENGTH);
  if (!linkId || !isUuid(linkId) || !target || !isUuid(target) || !reason) return badFields();
  return correctionResponse(await reassignLink(req.db, req.candidateId, linkId, target, reason));
}
