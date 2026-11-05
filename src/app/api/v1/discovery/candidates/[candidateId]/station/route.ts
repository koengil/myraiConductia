import { setStation } from '@/lib/discovery/api';
import {
  MAX_REASON_LENGTH,
  badFields,
  correctionResponse,
  readCorrectionRequest,
  text,
} from '@/lib/discovery/correctionRoute';
import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/discovery/candidates/{candidateId}/station: set the step the
 * MD says the deal is at. Body `{ stepId, reason }`, both required; `stepId` must
 * be a step of the MVP rail. The evidence's own suggestion stays beneath it. The
 * RPC acts on the caller's own session and checks deal-create authority.
 */
export async function POST(request: Request, context: { params: Promise<{ candidateId: string }> }) {
  const req = await readCorrectionRequest(request, context);
  if (!req.ok) return req.response;
  const stepId = typeof req.body.stepId === 'string' ? req.body.stepId : null;
  const reason = text(req.body.reason, MAX_REASON_LENGTH);
  if (!stepId || !reason) return badFields();
  if (!orderedSteps(MVP_DEAL_RAIL).some((step) => step.id === stepId)) return badFields();
  return correctionResponse(await setStation(req.db, req.candidateId, stepId, reason));
}
