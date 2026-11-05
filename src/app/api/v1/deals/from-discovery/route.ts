import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { RAIL_CENSUS_VERSION } from '@/lib/constants/dealSteps';
import { validateGate0Input, type DealCreateBody } from '@/lib/deals/createDealInput';
import { errorCodeOf } from '@/lib/errors/upstream';
import { MVP_DEAL_RAIL, phaseForStep, railSeedRows, stepBySeq } from '@/lib/rail/dealRail';

export const dynamic = 'force-dynamic';

type PromoteBody = DealCreateBody & { candidateId?: string };

/**
 * POST /api/v1/deals/from-discovery: promote a proposed deal into a mandate.
 *
 * This is Gate 0's zone (admin client, the verified session user), not the
 * discovery zone, and it is declared `definer_rpc` in
 * src/lib/mailboxAccess/agentSurfaces.ts: it reaches deal discovery only by
 * calling discovery_promote_candidate, a service-role definer that wraps the
 * unchanged create_deal_gate0_core and checks the actor itself (the actor must
 * see the candidate and be able to create deals). The route names no table,
 * imports nothing under src/lib/discovery/ and never provisions a data room.
 *
 * Same contract as POST /api/v1/deals: validateGate0Input runs the mask, roles,
 * attestation and MNPI screen first. The MD types the code name and the target;
 * a picked company, a theme or a rail template is refused (design T11 b).
 */
export async function POST(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: PromoteBody;
  try {
    body = (await request.json()) as PromoteBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!body.candidateId || !isUuid(body.candidateId)) return jsonError('candidateId is required', 400);
  if (body.targetCompanyId || body.codenameTheme || body.railTemplate) {
    return jsonError('Type the code name and the target', 400);
  }

  const validated = await validateGate0Input(auth.admin, auth.user.id, body);
  if (!validated.ok) {
    return NextResponse.json(validated.rejection.body, { status: validated.rejection.status });
  }
  const input = validated.input;

  const entry =
    typeof body.entryStepSeq === 'number' && body.entryStepSeq >= 1
      ? stepBySeq(Math.floor(body.entryStepSeq), MVP_DEAL_RAIL)
      : undefined;
  if (!entry) return jsonError('Choose a step on the rail', 400);
  const phase = phaseForStep(entry.id, MVP_DEAL_RAIL);

  const { data, error } = await auth.admin.rpc('discovery_promote_candidate', {
    p_actor_id: input.actorId,
    p_tenant_id: input.tenantId,
    p_bank_id: input.bankId,
    p_candidate_id: body.candidateId,
    p_codename: input.codename,
    p_target_name: input.targetName,
    p_entry_step_seq: entry.seq,
    p_entry_phase: phase?.index ?? 1,
    // deals.status: intake until the mandate is won (phase 1), active after; the function closes a closed one.
    p_entry_status: phase?.dealStatus === 'intake' ? 'intake' : 'active',
    p_members: input.members,
    p_screening: input.screening,
    p_steps: railSeedRows(MVP_DEAL_RAIL),
    p_census_version: RAIL_CENSUS_VERSION,
    p_conflicts: input.conflicts,
  });
  if (error) return promoteErrorResponse(error);

  const result = data as { deal: { id: string; code: string }; memberships: unknown; notified: unknown };
  return NextResponse.json(
    { deal: result.deal, memberships: result.memberships, notified: result.notified, screening: input.screening },
    { status: 201 },
  );
}

/**
 * Gate 0's error map, plus the promotion's own codes. already_promoted shares
 * SQLSTATE 23505 with a code name in use, so the message decides first.
 */
function promoteErrorResponse(error: { message?: string; code?: string }): NextResponse {
  const message = error.message || 'Deal create failed';
  const code = error.code;
  if (/already_promoted/.test(message)) return jsonError('This proposed deal is already a mandate', 409);
  if (code === 'P0002' || /not_visible/.test(message)) return jsonError('Proposed deal not found', 404);
  if (code === '55000' || /candidate_state/.test(message)) return jsonError('This proposed deal can no longer be promoted', 409);
  if (code === '55P03') return jsonError('Discovery is updating this deal. Try again in a moment.', 409);
  if (code === '42501' || /no_authority|not permitted to create deals/i.test(message)) {
    return jsonError('Not permitted to create deals', 403);
  }
  if (code === '23505' || /codename/i.test(message)) {
    return jsonError('Code name is already in use on a live deal', 409);
  }
  if (/wall breach/i.test(message)) return jsonError(message, 422);
  if (/invalid deal role/i.test(message)) return jsonError(message, 400);
  if (/conflicts approval/i.test(message)) return jsonError(message, 400);
  if (/no gate0 notify recipient/i.test(message)) {
    return jsonError(
      'No one is assigned to receive new-mandate notices. Assign Receive new-mandate notices on Roles, then try again.',
      400,
    );
  }
  // The database's own message stays on the server; the client gets a fixed one.
  console.error('[from-discovery] promotion failed', { code: errorCodeOf(error) });
  return jsonError('Deal create failed', 500);
}
