import { isUuid } from '@/lib/api/v1/http';
import { splitCandidate } from '@/lib/discovery/api';
import {
  MAX_NAME_LENGTH,
  MAX_REASON_LENGTH,
  badFields,
  correctionResponse,
  readCorrectionRequest,
  text,
} from '@/lib/discovery/correctionRoute';

export const dynamic = 'force-dynamic';

const MAX_SPLIT_ITEMS = 500;

/**
 * POST /api/v1/discovery/candidates/{candidateId}/split: move some of this
 * proposed deal's emails onto a new proposed deal. Body `{ itemIds, name,
 * reason }`, all required: the source items to move, the new deal's name and why.
 * The original keeps at least one email, and a re-run leaves both deals as they
 * are. The RPC acts on the caller's own session and checks deal-create authority.
 */
export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }) {
  const req = await readCorrectionRequest(request, context);
  if (!req.ok) return req.response;
  const ids = req.body.itemIds;
  const name = text(req.body.name, MAX_NAME_LENGTH);
  const reason = text(req.body.reason, MAX_REASON_LENGTH);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SPLIT_ITEMS) return badFields();
  if (!ids.every((id): id is string => typeof id === 'string' && isUuid(id))) return badFields();
  if (!name || !reason) return badFields();
  return correctionResponse(await splitCandidate(req.db, req.candidateId, [...new Set(ids)], name, reason));
}
