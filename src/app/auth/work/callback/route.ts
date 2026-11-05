import type { NextRequest } from 'next/server';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { safeAuthDestination } from '@/lib/auth/redirect';
import {
  ATTEMPT_COOKIE,
  decodeAttemptCookie,
  digest,
  isPendingIsolated,
} from '@/lib/auth/workIdentity';
import { hasWorkIdentityHookClaim } from '@/lib/auth/workIdentityHook';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import {
  WORK_IDENTITY_FLAG,
  callbackErrorCode,
  errorCodeFrom,
  hasUnboundWorkIdentity,
  notFound,
  readCodeVerifier,
  redirectTo,
  withParam,
} from '../_shared';
import { dbFailure } from '@/lib/errors/upstream';

/**
 * Shared OAuth callback for invitation and returning sign-in (#316 section 4).
 * With an attempt cookie the session claims that attempt and continues to
 * two-factor, then confirmation. Without one, routing follows the profile's
 * CURRENT state: a pending isolated profile has no invitation in hand and is
 * signed out; anyone else continues to two-factor. Before either, a session
 * with no email, no hook claim, or an unbound identity (and no pending
 * invitation) is refused and signed out locally.
 */
export async function GET(request: NextRequest) {
  if (!(await isFlagEnabled(WORK_IDENTITY_FLAG))) return notFound();

  const params = request.nextUrl.searchParams;
  const attempt = decodeAttemptCookie(request.cookies.get(ATTEMPT_COOKIE)?.value);
  const failPage = attempt ? '/join' : '/sign-in';
  const fail = (code: string) => {
    // On the invitation path the hook's "not connected" refusal means the
    // invited address already belongs to an account: sign in, then connect.
    const shown =
      attempt && code === WORK_IDENTITY_ERROR.NOT_CONNECTED
        ? WORK_IDENTITY_ERROR.EXISTING_ACCOUNT
        : code;
    const response = redirectTo(request, withParam(failPage, 'error', shown));
    response.cookies.delete(ATTEMPT_COOKIE);
    return response;
  };

  if (params.get('error')) return fail(callbackErrorCode(params));
  const code = params.get('code');
  if (!code) return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);
  }

  // Read before the exchange consumes it: the claim proves the attempt was
  // issued for this same OAuth flow (F14).
  const verifier = await readCodeVerifier((name) => request.cookies.get(name)?.value);

  // The access token hook runs here: its refusals surface as exchange errors.
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  const user = data?.user;
  if (error || !user) return fail(errorCodeFrom(error?.message));

  // A work identity without an address cannot be matched to an invitation or
  // an account; refuse it before anything else reads the session.
  if (!user.email) {
    await supabase.auth.signOut({ scope: 'local' });
    return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);
  }

  // Fail closed (#316, Option B): a token the hook did not stamp means the
  // project does not run the hook, so no rule vetted this sign-in.
  if (!hasWorkIdentityHookClaim(data.session?.access_token)) {
    console.error('work_identity_hook_missing');
    await supabase.auth.signOut({ scope: 'local' });
    return fail(WORK_IDENTITY_ERROR.NOT_CONNECTED);
  }

  let profile: { status: string | null; company_id: string | null; tenant_id: string | null } | null;
  try {
    const { data: row, error: profileError } = await createSupabaseAdminClient()
      .from('users')
      .select('status, company_id, tenant_id')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) throw dbFailure('Profile lookup', profileError);
    profile = row;
  } catch {
    await supabase.auth.signOut();
    return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);
  }

  const pendingIsolated = isPendingIsolated(profile ? { id: user.id, ...profile } : null);

  // A pending invitee legitimately holds an identity no binding names yet; the
  // claim below creates it. Anyone else with an unbound identity is refused,
  // mirroring the hook's rule (diagnostic for sessions the hook did not gate).
  if (!pendingIsolated && (await hasUnboundWorkIdentity(user.id))) {
    console.error('work_identity_unbound_session');
    await supabase.auth.signOut({ scope: 'local' });
    return fail(WORK_IDENTITY_ERROR.NOT_CONNECTED);
  }

  if (attempt) {
    // The claim is service-role only: this exchange, not the caller, vouches
    // that the session came from the attempt's own flow (F14).
    let claimError: { message: string } | null;
    try {
      ({ error: claimError } = await createSupabaseAdminClient().rpc('claim_work_identity_attempt', {
        p_attempt_id: attempt.attemptId,
        p_secret_digest: digest(attempt.secret),
        p_code_verifier: verifier,
        p_user_id: user.id,
        p_session_id: sessionIdOf(data.session?.access_token),
      }));
    } catch {
      claimError = { message: WORK_IDENTITY_ERROR.PROVIDER_FAILED };
    }
    if (claimError) {
      await supabase.auth.signOut();
      return fail(errorCodeFrom(claimError.message, WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED));
    }
    return redirectTo(request, '/two-factor?redirectTo=%2Fjoin%2Fconfirm');
  }

  if (pendingIsolated) {
    await supabase.auth.signOut();
    return fail(WORK_IDENTITY_ERROR.NO_INVITATION);
  }

  const destination = safeAuthDestination(params.get('next'));
  return redirectTo(request, withParam('/two-factor', 'redirectTo', destination));
}

/** The `session_id` claim of the access token this route just minted. */
function sessionIdOf(accessToken: string | undefined): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken!.split('.')[1], 'base64url').toString());
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}
