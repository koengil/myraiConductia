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
import {
  isAvailable,
  parseSkillReference,
  readStep,
  readStepVersions,
  unavailableReasonFor,
} from '@/lib/skillRun/versions';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const gate = await requireFlag('skill_authoring');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  const body = (await request.json().catch(() => null)) as { reference?: unknown } | null;
  const reference = parseSkillReference(body?.reference);
  if (!reference) return jsonError('A skill reference is required', 422);

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
  if (!capabilities.canEditWork) return jsonError('Not permitted to change this step', 403);

  let available;
  try {
    available = await readStepVersions(auth.admin, deal, stepId);
  } catch (error) {
    if (error instanceof IgnatiousRequestError) return ignatiousErrorResponse(error);
    throw error;
  }
  if (!available) return jsonError('Unknown step', 404);

  if (!isAvailable(available, reference)) {
    const currentIsSameSkill =
      reference.kind === 'publication' &&
      available.current?.kind === 'publication' &&
      available.current.skillId === reference.skillId;
    if (currentIsSameSkill && available.projectUnavailableReason) {
      return jsonError(available.projectUnavailableReason, 502);
    }
    const reason = unavailableReasonFor(available, reference);
    return jsonError(reason ?? 'That version is not available for this step', 422);
  }

  const { error } = await auth.admin.rpc('rail_rebind_step', {
    p_deal_id: deal.id,
    p_actor_id: auth.user.id,
    p_deal_step_id: row.id,
    p_reference: reference,
    p_source: 'selection',
  });
  if (error) return jsonError('Unable to change this step version', 500);

  return NextResponse.json({ binding: reference });
}
