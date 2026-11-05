import { NextResponse } from 'next/server';
import { isAuthRetryableFetchError, type AuthError, type SupabaseClient } from '@supabase/supabase-js';
import { isMfaRequiredForUser } from '@/lib/auth/mfaPolicy';
import {
  WORK_IDENTITY_HOOK_REFUSAL,
  enforceWorkIdentityHook,
} from '@/lib/auth/workIdentityHook';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { USER_STATUS } from '@/lib/constants/users';
import { dbFailure, errorCodeOf } from '@/lib/errors/upstream';
import { refuse } from '@/lib/log/gate';

export type ApiUser = {
  id: string;
  email: string;
  /** The profile's firm, from the status read every request already makes. */
  companyId: string | null;
  /** A counterparty or adviser invited into a deal (users.is_external), never the bank's own staff. */
  isExternal?: boolean;
};

/**
 * Options for requireApiUser. `allowInvited` is the ONE sanctioned exception
 * to onboarding containment: POST /api/v1/invites/accept must be reachable by
 * a user whose profile status is still 'invited' (plan-v5 M3). Every other
 * route rejects such users with 403 onboarding_incomplete. A suspended
 * account is refused with 403 account_suspended on every route.
 */
export type RequireApiUserOptions = {
  allowInvited?: boolean;
  /** Narrow exception for invite verification and acceptance completion only. */
  allowAal1?: boolean;
  /** Require a proven AAL2 session even when the development policy exempts this user. */
  forceAal2?: boolean;
};

export async function requireApiUser(options: RequireApiUserOptions = {}): Promise<
  | { ok: true; user: ApiUser; admin: ReturnType<typeof createSupabaseAdminClient> }
  | { ok: false; response: NextResponse }
> {
  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return refuse(NextResponse.json({ error: 'Server misconfigured' }, { status: 503 }),
      { evt: 'auth_unavailable', reason: 'misconfigured', status: 503, gate: 'api' });
  }
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error && isAuthOutage(error)) {
    return refuse(authUnavailable(), { evt: 'auth_unavailable', reason: 'session_read', status: 503, gate: 'api' });
  }
  if (error || !user?.email) {
    return refuse(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      { evt: 'auth_denied', reason: 'no_session', status: 401, gate: 'api' });
  }

  // Before the AAL branch and regardless of allowAal1: a work-identity session
  // the token hook did not issue is refused on every route (#316).
  if ((await enforceWorkIdentityHook(supabase, user)) === 'refused') {
    return refuse(workIdentityHookRefused(),
      { evt: 'auth_denied', reason: 'work_identity_hook', status: 401, gate: 'api', user: user.id });
  }

  if (!options.allowAal1 && (options.forceAal2 || isMfaRequiredForUser(user))) {
    const { data: assurance, error: assuranceError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError) {
      return refuse(NextResponse.json({ error: 'mfa_unavailable' }, { status: 503 }),
        { evt: 'auth_unavailable', reason: 'mfa_level', status: 503, gate: 'api' });
    }
    if (assurance.currentLevel !== 'aal2') {
      return refuse(NextResponse.json({ error: 'mfa_required' }, { status: 403 }),
        { evt: 'auth_denied', reason: 'mfa_required', status: 403, gate: 'api', user: user.id });
    }
  }

  let admin: ReturnType<typeof createSupabaseAdminClient>;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return refuse(NextResponse.json({ error: 'Server misconfigured' }, { status: 503 }),
      { evt: 'auth_unavailable', reason: 'admin_client', status: 503, gate: 'api' });
  }

  // Status is read on every request, invited-allowed routes included: a
  // suspended account is refused everywhere (flag-independent, issue #316).
  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('status, company_id, is_external')
    .eq('id', user.id)
    .maybeSingle();
  // An unreadable profile must not pass the onboarding gate (#222).
  if (profileError) {
    return refuse(accessUnverified(), { evt: 'auth_unavailable', reason: 'profile_read', status: 503, gate: 'api' });
  }
  const company = profile?.company_id ?? undefined;
  if (profile?.status === USER_STATUS.SUSPENDED) {
    return refuse(NextResponse.json({ error: 'account_suspended' }, { status: 403 }),
      { evt: 'auth_denied', reason: 'account_suspended', status: 403, gate: 'api', user: user.id, company });
  }
  if (!options.allowInvited && profile?.status === USER_STATUS.INVITED) {
    return refuse(NextResponse.json({ error: 'onboarding_incomplete' }, { status: 403 }),
      { evt: 'auth_denied', reason: 'onboarding_incomplete', status: 403, gate: 'api', user: user.id, company });
  }

  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      companyId: profile?.company_id ?? null,
      isExternal: profile?.is_external === true,
    },
    admin,
  };
}

/**
 * Did getUser() fail because the auth provider is unreachable or erroring,
 * rather than because the session is missing or invalid? A network failure or
 * gateway 5xx surfaces as AuthRetryableFetchError, an unparseable reply as
 * AuthUnknownError, and a provider fault as a 5xx AuthApiError. Those are
 * outages (503), not logouts (401), so the client keeps its session (#222 PL-10).
 */
export function isAuthOutage(error: AuthError): boolean {
  return (
    isAuthRetryableFetchError(error) ||
    error.name === 'AuthUnknownError' ||
    (error.status ?? 0) >= 500
  );
}

/** 401 for a work-identity session whose token the hook did not issue. */
export function workIdentityHookRefused(): NextResponse {
  return NextResponse.json({ error: WORK_IDENTITY_HOOK_REFUSAL }, { status: 401 });
}

export function authUnavailable(): NextResponse {
  return jsonError('Authentication is temporarily unavailable. Try again.', 503);
}

export function accessUnverified(): NextResponse {
  return jsonError('Access could not be verified. Try again.', 503);
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * An audit_log insert was rejected (for example by the hash-chain trigger).
 * Fail the request and log it rather than report success for an action the
 * audit trail does not hold (#249). `message` says what did or did not happen.
 */
export function auditFailed(error: { message: string }, message: string): NextResponse {
  console.error(`[audit] ${message}`, { code: errorCodeOf(error) });
  return jsonError(message, 500);
}

/**
 * Is `value` a UUID? Used to route a `/deals/{idOrCode}` segment: a UUID is the
 * primary key, anything else is treated as the human-readable deal `code`
 * (PREFIX-YEAR-NNN). Passing a non-UUID to a Postgres `uuid` column errors, so
 * we must branch on this before querying.
 */
/**
 * Resolve a deal route segment that may be the primary-key UUID or the
 * human-readable deal code (project URLs use the code — see
 * deals/[dealId]/route.ts). Returns the canonical id + code, or null when no
 * such deal exists. Every deal-scoped handler must resolve BEFORE querying
 * deal_memberships/documents/deal_parties, or code-addressed requests 403.
 */
export async function resolveDealRef(
  admin: SupabaseClient,
  dealParam: string,
): Promise<{ id: string; code: string } | null> {
  const base = admin.from('deals').select('id, code');
  const { data, error } = await (isUuid(dealParam)
    ? base.eq('id', dealParam)
    : base.eq('code', dealParam)
  ).maybeSingle();
  // A lookup failure is a server fault, not a missing deal — throwing surfaces
  // it as a 500 instead of a misleading 404 (review 6bdabd9 finding 3).
  if (error) throw dbFailure('Deal lookup', error);
  return (data as { id: string; code: string } | null) ?? null;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Constrain a caller-supplied return path to an in-app path. `//evil.com` and
 * `/\evil.com` are protocol-relative in `new URL(value, origin)` and would
 * redirect off-site (open redirect); anything not starting with a single `/`
 * is rejected too. Falls back to `/`.
 */
export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}

/**
 * The shape of a deal code: PREFIX-YYYY-NNN. Minted codes have a 5-character
 * prefix (`mintDealCode` below, and the create_deal RPCs), seeded ones 2 or 6
 * (NW-2026-002, SUMMIT-2026-003), so the prefix length is open. The lenient
 * mail resolver uses it to read a ref that matches no deal: deal-shaped means
 * "a deal you cannot see", anything else is a sandbox slug (D65, #245).
 */
export const DEAL_CODE_SHAPE = /^[A-Z0-9]+-\d{4}-\d{3}$/i;

export function mintDealCode(codename: string): string {
  // Skip a leading "Project" token so the DISTINCTIVE word drives the prefix
  // ("Project Falcon" -> FALCO, not PROJE — every "Project X" collided on PROJE
  // before, G21). Falls back to the raw codename if nothing remains.
  const distinctive = codename.replace(/^\s*project\s+/i, '').trim() || codename;
  const prefix = distinctive
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 5)
    .toUpperCase()
    .padEnd(5, 'X');
  const year = new Date().getFullYear();
  const suffix = String(Math.floor(Math.random() * 900) + 100);
  return `${prefix}-${year}-${suffix}`;
}

/**
 * The session account carries no invite_id/credential_nonce (for example a
 * provider sign-in replaced its metadata). The only recovery is a resend,
 * which rewrites them server-side (plan 1e).
 */
export function inviteContextMissing() {
  return NextResponse.json(
    {
      error: 'This invitation needs to be resent. Ask the sender to resend it.',
      code: 'invite_context_missing',
    },
    { status: 409 },
  );
}
