import { NextResponse } from 'next/server';

import {
  classifyInternalUser,
  resolveDealStepCapabilities,
  userCanAccessDeal,
} from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { requireFlag } from '@/lib/flags/requireFlag';
import { IgnatiousRequestError } from '@/lib/ignatious/control-plane';
import { ignatiousErrorResponse } from '@/lib/ignatious/routeContext';
import { readStep, readStepVersions } from '@/lib/skillRun/versions';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  const deal = await loadDealByIdOrCode(auth.admin, dealId);
  if (!deal) return jsonError('Deal not found', 404);
  if (!(await userCanAccessDeal(auth.admin, auth.user.id, deal.id))) {
    return dealNotVisible();
  }

  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  const row = await readStep(auth.admin, deal.id, stepId);
  if (!row || typeof row.id !== 'string') return jsonError('Unknown step', 404);

  const capabilities = await resolveDealStepCapabilities(auth.admin, auth.user.id, deal.id, {
    assigned_to: (row.assigned_to as string | null) ?? null,
    status: (row.status as string) ?? 'pending',
  });
  if (capabilities === 'unreadable') return jsonError('Profile lookup failed', 500);
  if (!capabilities.canEditWork) return jsonError('Not permitted to view versions for this step', 403);

  try {
    const versions = await readStepVersions(auth.admin, deal, stepId);
    if (!versions) return jsonError('Unknown step', 404);
    return NextResponse.json(versions);
  } catch (error) {
    if (error instanceof IgnatiousRequestError) return ignatiousErrorResponse(error);
    throw error;
  }
}
