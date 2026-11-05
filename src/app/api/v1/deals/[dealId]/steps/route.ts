import { NextResponse } from 'next/server';

import { classifyInternalUser, userCanAccessDeal } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import {
  listDealStepsWithDatarooms,
  loadDealByIdOrCode,
  seedDataroomsForDeal,
} from '@/lib/dataroom/steps';

type RouteContext = { params: Promise<{ dealId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;

  let deal;
  try {
    deal = await loadDealByIdOrCode(auth.admin, dealId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve deal';
    return jsonError(message, 500);
  }
  if (!deal) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return dealNotVisible();

  // Internal-only surface: rail-step datarooms are bank work product.
  // Fail closed — a lookup error is a server fault, not access.
  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  try {
    let steps = await listDealStepsWithDatarooms(auth.admin, deal.id);
    if (steps.length === 0) {
      await seedDataroomsForDeal(auth.admin, deal.id);
      steps = await listDealStepsWithDatarooms(auth.admin, deal.id);
    }

    return NextResponse.json({
      steps: steps.map((step) => ({
        stepId: step.stepId,
        label: step.label,
        seq: step.seq,
        railStatus: step.railStatus,
        requiresUpload: step.requiresUpload,
        minPhase: step.minPhase,
        dataroom: step.dataroom
          ? {
              id: step.dataroom.id,
              provider: step.dataroom.provider,
              boxFolderId: step.dataroom.box_folder_id,
              boxFolderUrl: step.dataroom.box_folder_url,
              provisioned: Boolean(step.dataroom.box_folder_id),
            }
          : null,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load steps';
    return jsonError(message, 500);
  }
}
