import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import { requireStructureAuthority } from '@/lib/rail/railRouteGuard';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const { dealId, stepId } = await context.params;
  const guard = await requireStructureAuthority(dealId);
  if (!guard.ok) return guard.response;

  const { data, error } = await guard.auth.admin.rpc('rail_remove_step', {
    p_deal_id: guard.deal.id,
    p_actor_id: guard.auth.user.id,
    p_step_id: stepId,
    p_protected_ids: [...PROTECTED_STEP_IDS],
  });

  if (error?.code === 'P0003') return jsonError('A completed step cannot be removed', 409);
  if (error?.code === 'P0004') return jsonError('This step is required and cannot be removed', 409);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json(data);
}
