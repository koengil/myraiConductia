import { NextResponse } from 'next/server';

import { auditFailed, jsonError } from '@/lib/api/v1/http';
import {
  isSkipApproverIneligible,
  isSkipDeadlock,
  resolveSkipApprover,
  SKIP_APPROVER_INELIGIBLE_ANSWER,
  skipRetryResponse,
} from '@/lib/api/v1/stepSkip';
import { requireStepWorkAuthority } from '@/lib/rail/railRouteGuard';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

type SkipBody = {
  approverId?: unknown;
  reason?: string;
};

export async function POST(request: Request, context: RouteContext) {
  const { dealId, stepId } = await context.params;
  const guard = await requireStepWorkAuthority(dealId, stepId);
  if (!guard.ok) return guard.response;

  let body: SkipBody;
  try {
    body = (await request.json()) as SkipBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const reason = body.reason?.trim();
  if (!reason) return jsonError('A reason is required', 400);

  const approver = await resolveSkipApprover(
    guard.auth.admin,
    guard.deal.id,
    guard.auth.user.id,
    body.approverId,
  );
  if (!approver.ok) return jsonError(approver.error, approver.status);

  const { data, error } = await guard.auth.admin.rpc('rail_skip_step', {
    p_deal_id: guard.deal.id,
    p_actor_id: guard.auth.user.id,
    p_step_id: stepId,
    p_approver_id: approver.id,
    p_reason: reason,
  });

  // The seat was lost between the check above and the write: same answer as the
  // check, never the raw database text. Any other 42501 (a grant error) stays a 500.
  if (isSkipApproverIneligible(error)) return jsonError(SKIP_APPROVER_INELIGIBLE_ANSWER, 400);
  // Aborted to break a lock cycle: nothing was written, the client may resend.
  if (isSkipDeadlock(error)) return skipRetryResponse();
  if (error?.code === 'P0003') return jsonError('A completed or skipped step cannot be skipped', 409);
  if (error?.code === 'P0001') return jsonError(error.message, 400);
  // Anything else, a grant error included, is a 500 that never echoes the database text.
  if (error) return auditFailed(error, 'The skip could not be recorded');

  return NextResponse.json(data);
}
