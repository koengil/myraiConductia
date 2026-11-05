// Server-side shape of a logged skip on a rail step (PATCH /steps/{id} { skip }).
// The Skip modal promises "approver and reason are logged on the deal record";
// this is that record: validated here, written to deal_steps.work.skip and the
// audit log by the route. The client names the approver by user id only; the
// route resolves the name and role with resolveSkipApprover (#312).

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/api/v1/http';
import { SKIP_APPROVER_DEAL_ROLES } from '@/lib/constants/dealSteps';
import type { DealRole } from '@/lib/constants/roles';
import { TABLE } from '@/lib/constants/tables';
import { USER_STATUS } from '@/lib/constants/users';

export type StepSkipInput = {
  /** Unchecked here: resolveSkipApprover verifies it (absent means the actor). */
  approverId?: unknown;
  reason: string;
};

export type StepSkipParse = { ok: true; skip: StepSkipInput } | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Only the approver id and the reason are taken from the client. The old
 * `approver` / `approverRole` keys (a stale tab) are ignored, not rejected:
 * free text never becomes an audit fact (#312).
 */
export function parseStepSkip(body: unknown): StepSkipParse {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'skip must be an object with a reason' };
  }
  const raw = body as Record<string, unknown>;
  const reason = text(raw.reason);
  if (!reason) return { ok: false, error: 'skip.reason is required' };
  return { ok: true, skip: { approverId: raw.approverId, reason } };
}

export type SkipApprover = { id: string; name: string; dealRole: DealRole };

export type SkipApproverResult =
  | ({ ok: true } & SkipApprover)
  | { ok: false; status: 400 | 500; error: string };

type ApproverUser = {
  status: string | null;
  display_name: string | null;
  full_name: string | null;
  email: string | null;
};

type ApproverSeat = { deal_role: string; user: ApproverUser | ApproverUser[] | null };

const INELIGIBLE = 'The approver must hold an active, eligible seat on this deal';

/** The message rail_skip_approver raises with SQLSTATE 42501 (migration 20261022090000). */
const SKIP_APPROVER_INELIGIBLE_MESSAGE = 'skip_approver_ineligible';

/**
 * A seat or user row changed between the check above and the write, and the
 * database refused the approver (#312). Only this exact refusal: Postgres also
 * raises 42501 for a missing grant, and that must stay a server error.
 */
export function isSkipApproverIneligible(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  return error?.code === '42501' && error.message === SKIP_APPROVER_INELIGIBLE_MESSAGE;
}

/** The 400 answer for an approver the database refused, same text as resolveSkipApprover. */
export const SKIP_APPROVER_INELIGIBLE_ANSWER = INELIGIBLE;

/** The fixed code of a skip the database aborted to break a lock cycle; the client may resend it. */
export const SKIP_RETRY_CODE = 'skip_retry';

/**
 * SQLSTATE 40P01: Postgres aborted the skip's transaction to break a deadlock with
 * another write on the same user or deal. Nothing was recorded, so the same request
 * can be sent again. Defence in depth: the lock order (user, seat, then the audit
 * chain) has no known cycle (#312).
 */
export function isSkipDeadlock(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === '40P01';
}

/** A retryable 409 with the fixed code and no database text. */
export function skipRetryResponse(): NextResponse {
  return NextResponse.json(
    { error: 'The skip met a concurrent change and was not recorded. Send it again.', code: SKIP_RETRY_CODE },
    { status: 409, headers: { 'Retry-After': '1' } },
  );
}

/**
 * The skip approver, verified on the server (#312). The client names a user id;
 * no id means the actor approves. Either way the id must hold an active seat on
 * this deal in SKIP_APPROVER_DEAL_ROLES, and the name and role come from the
 * database, never from the request body.
 */
export async function resolveSkipApprover(
  admin: SupabaseClient,
  dealId: string,
  actorId: string,
  rawId: unknown,
): Promise<SkipApproverResult> {
  const id = rawId ?? actorId;
  if (typeof id !== 'string' || !isUuid(id)) {
    return { ok: false, status: 400, error: 'skip.approverId must be a user id' };
  }
  // deal_memberships has two FKs to users (user_id, added_by): the embed needs the hint.
  const { data, error } = await admin
    .from(TABLE.DEAL_MEMBERSHIPS)
    .select('deal_role, user:users!deal_memberships_user_id_fkey(status, display_name, full_name, email)')
    .eq('deal_id', dealId)
    .eq('user_id', id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: 'Approver lookup failed' };
  const seat = data as ApproverSeat | null;
  const user = Array.isArray(seat?.user) ? seat.user[0] : seat?.user;
  if (
    !seat ||
    !user ||
    user.status !== USER_STATUS.ACTIVE ||
    !(SKIP_APPROVER_DEAL_ROLES as readonly string[]).includes(seat.deal_role)
  ) {
    return { ok: false, status: 400, error: INELIGIBLE };
  }
  return {
    ok: true,
    id,
    name: user.display_name?.trim() || user.full_name?.trim() || user.email || 'Banker',
    dealRole: seat.deal_role as DealRole,
  };
}
