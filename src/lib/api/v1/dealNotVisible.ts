import type { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { userCanAccessDeal, userCanInviteChecked } from '@/lib/api/v1/access';
import { accessUnverified, jsonError } from '@/lib/api/v1/http';

/** The error every deal-scoped route answers when no deal matches the segment. */
export const DEAL_NOT_FOUND_MESSAGE = 'Deal not found';

/**
 * The answer to a caller with no seat on the deal and no oversight of it.
 *
 * It is the "no such deal" 404, byte for byte: same status, same body, same
 * headers. A 403 here would confirm that the deal exists, and deal codes
 * (CODENAME5-YYYY-NNN) are guessable, so the difference is an oracle for what
 * the information barrier is meant to hide (decision-log D65). The response
 * time still differs, because the missing-deal branch skips the access query;
 * that residual is accepted and recorded with the fetch-then-filter debt.
 *
 * Seated callers keep their 403s (a non-MD moving the cursor backwards, an
 * external member on an internal surface): they already know the deal exists.
 */
export function dealNotVisible(): NextResponse {
  return jsonError(DEAL_NOT_FOUND_MESSAGE, 404);
}

/**
 * A role-denied 403 for a caller who can see the deal, and `dealNotVisible()`
 * for one who cannot. For routes whose first gate is an authority check (MD,
 * member manager) rather than `userCanAccessDeal`, so an unseated caller never
 * learns the deal exists from the authority refusal.
 */
export async function forbiddenOrNotVisible(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
  message: string,
): Promise<NextResponse> {
  return (await userCanAccessDeal(admin, userId, dealId))
    ? jsonError(message, 403)
    : dealNotVisible();
}

/** A company id that matches no row, for a caller who belongs to no company. */
const NO_COMPANY = '00000000-0000-0000-0000-000000000000';

/**
 * The invite family's visibility gate, run once right after the deal ref
 * resolves and before any body validation, authority check, candidate lookup
 * or perimeter computation. Returns null when the caller may proceed, and the
 * response to send otherwise.
 *
 * The invite family admits more callers than `userCanAccessDeal`: anyone who
 * holds deal-scoped invite authority without a seat, such as the external
 * director of a party company or a director of the deal's owning bank. So the
 * gate passes a caller who can see the deal OR who `userCanInviteChecked`
 * admits on it, onto their own company. The predicate is called, not
 * restated, so a tier added to it later is admitted here too. Such callers
 * already know the deal exists, so passing them reveals nothing.
 *
 * Everyone else gets `dealNotVisible()`, the "no such deal" answer, so another
 * firm's admin, a non-party external director and an unseated banker cannot
 * tell a real deal from a made-up code through a 403, a 200 or a 400. A failed
 * authority read is a 503, never a pass.
 */
export async function inviteDealHidden(
  admin: SupabaseClient,
  caller: { id: string; companyId: string | null },
  dealId: string,
): Promise<NextResponse | null> {
  if (await userCanAccessDeal(admin, caller.id, dealId)) return null;
  const authority = await userCanInviteChecked(admin, caller.id, {
    companyId: caller.companyId ?? NO_COMPANY,
    dealId,
  });
  if (authority === true) return null;
  return authority === 'unreadable' ? accessUnverified() : dealNotVisible();
}
