import { NextResponse } from 'next/server';

import { classifyInternalUser, userCanAccessDeal } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { getBoxClient } from '@/lib/box';
import { errorCodeOf } from '@/lib/errors/upstream';
import {
  listDealStepsWithDatarooms,
  loadDealByIdOrCode,
  provisionDataroomFolder,
} from '@/lib/dataroom/steps';
import { orderedSteps } from '@/lib/rail/dealRail';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

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

  if (!orderedSteps().some((s) => s.id === stepId)) {
    return jsonError('Unknown rail step id', 400);
  }

  try {
    const dataroom = await provisionDataroomFolder(
      auth.admin,
      deal.id,
      stepId,
      deal.code,
    );

    const box = getBoxClient();
    const files = dataroom.box_folder_id
      ? await box.listFolderItems(dataroom.box_folder_id)
      : [];

    const steps = await listDealStepsWithDatarooms(auth.admin, deal.id);
    const step = steps.find((s) => s.stepId === stepId);

    return NextResponse.json({
      step: step
        ? {
            stepId: step.stepId,
            label: step.label,
            requiresUpload: step.requiresUpload,
            minPhase: step.minPhase,
            railStatus: step.railStatus,
          }
        : null,
      dataroom: {
        id: dataroom.id,
        provider: dataroom.provider,
        boxFolderId: dataroom.box_folder_id,
        boxFolderUrl: dataroom.box_folder_url,
      },
      files,
      boxMode: process.env.BOX_CLIENT_ID ? 'live' : 'mock',
    });
  } catch (err) {
    // Box and Supabase text can quote file and folder names; the response carries a code only.
    return jsonError(`Dataroom storage failed (${errorCodeOf(err)})`, 500);
  }
}
