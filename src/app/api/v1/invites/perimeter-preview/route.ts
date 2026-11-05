import { NextResponse } from 'next/server';
import { normalizeInviteEmail } from '@/lib/api/v1/inviteDomain';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { inviteDealHidden } from '@/lib/api/v1/dealNotVisible';
import {
  perimeterForMember,
  perimeterForProposal,
  type PerimeterResult,
} from '@/lib/perimeter/perimeter';

/**
 * POST /api/v1/invites/perimeter-preview — what a seat would be able to reach.
 *
 * Deliberately NOT nested under /deals/{dealId}. Gate 0 composes invitations
 * before the deal exists, and the brief forbids a third invitation flow, so the
 * deal is optional context here rather than the route's identity.
 *
 * Two modes, each authorized by the same predicate that guards the real action
 * it previews:
 *   proposal — assessProposal, the same check the send route makes. A proposal
 *              that could not be sent yields no perimeter, so this cannot be
 *              used to probe another tenant's document volumes.
 *   member   — userIsDealMd, the same check the phase raise makes, refusing a
 *              downgrade for the same reason: disclosure is monotonic.
 *
 * Read-only. The computation is pure, so previewing writes no membership, no
 * grant and no document-view audit event (criterion B9).
 */

type PreviewBody = {
  proposal?: {
    email?: string;
    companyId?: string;
    companyRole?: string;
    dealId?: string | null;
    dealRole?: string | null;
    phase?: number;
  };
  member?: {
    dealId?: string;
    userId?: string;
    phase?: number;
  };
};

function failureResponse(result: Exclude<PerimeterResult, { ok: true }>) {
  switch (result.reason) {
    case 'phase_downgrade':
      return jsonError('Phase can only be raised. Disclosure is monotonic.', 409);
    case 'invalid':
      return jsonError('This proposal is not valid for that company or deal', 400);
    case 'company_requires_director':
      return NextResponse.json(
        {
          error: 'This company needs its first active director. Invite this person as Company Director.',
          code: 'company_requires_director',
        },
        { status: 409 },
      );
    case 'unavailable':
      // Fails closed and says so, rather than reporting a partial or zero
      // perimeter that would read as "they can see nothing" (criterion B10).
      return jsonError('The access preview could not be built', 503);
    case 'forbidden':
    default:
      // Opaque on purpose: an actor without authority learns nothing about
      // whether the target company, deal or member exists.
      return jsonError('Forbidden', 403);
  }
}

export async function POST(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: PreviewBody;
  try {
    body = (await request.json()) as PreviewBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (Boolean(body.proposal) === Boolean(body.member)) {
    return jsonError('Provide exactly one of proposal or member', 400);
  }

  if (body.member) {
    const { userId, phase } = body.member;
    if (!userId || !body.member.dealId) {
      return jsonError('dealId and userId are required', 400);
    }
    if (typeof phase !== 'number') {
      return jsonError('phase is required', 400);
    }
    const deal = await resolveDealRef(auth.admin, body.member.dealId);
    if (!deal) return jsonError('Deal not found', 404);
    // Before perimeterForMember, whose phase check would otherwise answer an
    // unseated caller 400 for a real deal and 404 for a made-up one (D65).
    const hidden = await inviteDealHidden(auth.admin, auth.user, deal.id);
    if (hidden) return hidden;

    const result = await perimeterForMember(auth.admin, auth.user.id, deal.id, userId, phase);
    if (!result.ok) return failureResponse(result);
    return NextResponse.json({ dealContext: 'existing', perimeter: result.perimeter });
  }

  const proposal = body.proposal!;
  const email = normalizeInviteEmail(proposal.email ?? '');
  if (!email) return jsonError('A valid email is required', 400);
  if (!proposal.companyId) return jsonError('companyId is required', 400);
  if ((proposal.dealId == null) !== (proposal.dealRole == null)) {
    return jsonError('dealId and dealRole must be provided together', 400);
  }

  // Gate 0 previews before the deal exists. Absent deal context is a first-class
  // case, not an error: the seat is described honestly with no document set yet.
  let dealId: string | null = null;
  if (proposal.dealId) {
    const deal = await resolveDealRef(auth.admin, proposal.dealId);
    if (!deal) return jsonError('Deal not found', 404);
    const hidden = await inviteDealHidden(auth.admin, auth.user, deal.id);
    if (hidden) return hidden;
    dealId = deal.id;
  }

  const result = await perimeterForProposal(auth.admin, auth.user.id, {
    email,
    companyId: proposal.companyId,
    companyRole: proposal.companyRole ?? 'member',
    dealId,
    dealRole: proposal.dealRole ?? null,
    phase: proposal.phase ?? 0,
  });
  if (!result.ok) return failureResponse(result);

  return NextResponse.json({
    dealContext: dealId ? 'existing' : 'proposed',
    perimeter: result.perimeter,
  });
}
