import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireStructureAuthority } from '@/lib/rail/railRouteGuard';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const { dealId, stepId } = await context.params;
  const guard = await requireStructureAuthority(dealId);
  if (!guard.ok) return guard.response;

  const { data, error } = await guard.auth.admin.rpc('rail_restore_step', {
    p_deal_id: guard.deal.id,
    p_actor_id: guard.auth.user.id,
    p_step_id: stepId,
  });

  if (error) return jsonError(error.message, 500);

  return NextResponse.json(data);
}
