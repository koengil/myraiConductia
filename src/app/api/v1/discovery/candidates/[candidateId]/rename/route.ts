import { renameCandidate } from '@/lib/discovery/api';
import {
  MAX_NAME_LENGTH,
  MAX_REASON_LENGTH,
  badFields,
  correctionResponse,
  readCorrectionRequest,
  text,
} from '@/lib/discovery/correctionRoute';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/discovery/candidates/{candidateId}/rename: give a proposed deal
 * the name the MD uses. Body `{ name, reason? }`. A rename pins the candidate, so
 * a re-run of the classification never renames it back. The RPC acts on the
 * caller's own session and checks deal-create authority.
 */
export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }) {
  const req = await readCorrectionRequest(request, context);
  if (!req.ok) return req.response;
  const name = text(req.body.name, MAX_NAME_LENGTH);
  if (!name) return badFields();
  const given = req.body.reason;
  const reason = given === undefined || given === null ? null : text(given, MAX_REASON_LENGTH);
  if (given !== undefined && given !== null && reason === null) return badFields();
  return correctionResponse(await renameCandidate(req.db, req.candidateId, name, reason));
}
