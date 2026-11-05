import { NextResponse, type NextRequest } from 'next/server';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { safeAuthDestination } from '@/lib/auth/redirect';
import { WORK_IDENTITY_HOOK_REFUSAL, enforceWorkIdentityHook } from '@/lib/auth/workIdentityHook';
import {
  CONNECT_COOKIE,
  digest,
  flowCookieOptions,
  newFlowSecret,
} from '@/lib/auth/workIdentity';
import {
  WORK_IDENTITY_CONNECT_TTL_SECONDS,
  WORK_IDENTITY_COOKIE,
  WORK_IDENTITY_ERROR,
  isWorkIdentityProvider,
} from '@/lib/constants/workIdentity';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  WORK_IDENTITY_FLAG,
  absoluteUrl,
  errorCodeFrom,
  notFound,
  redirectTo,
  startOAuth,
  withParam,
} from '../_shared';

/**
 * Connect a work account to an existing, active Conductia account (#316 1e).
 * Requires the caller's AAL2 session; records a connect intent bound to that
 * session and starts a server-side PKCE `linkIdentity`. The callback proves
 * the link with the auth code and the verifier only this server holds.
 */
export async function GET(request: NextRequest) {
  if (!(await isFlagEnabled(WORK_IDENTITY_FLAG))) return notFound();

  const params = request.nextUrl.searchParams;
  const provider = params.get('provider');
  const destination = safeAuthDestination(params.get('redirectTo'));
  const fail = (code: string) => {
    const response = redirectTo(request, withParam(destination, 'error', code));
    // An unread success proof from an earlier connect must not vouch for a later ?connected=1.
    response.cookies.delete(WORK_IDENTITY_COOKIE.CONNECTED);
    return response;
  };
  if (!isWorkIdentityProvider(provider)) return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);

  const self = `${request.nextUrl.pathname}?${new URLSearchParams({
    provider,
    redirectTo: destination,
  }).toString()}`;

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return redirectTo(request, withParam('/sign-in', 'redirectTo', self));

  // The middleware does not run on /auth/work, so this route checks the hook
  // claim itself, before the AAL check and before any RPC (#316). A Route
  // Handler persists the refresh or the local sign-out the check writes.
  if ((await enforceWorkIdentityHook(supabase, user)) === 'refused') {
    return fail(WORK_IDENTITY_HOOK_REFUSAL);
  }

  const { data: assurance } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assurance?.currentLevel !== 'aal2') {
    // One trip through two-factor; a second arrival still at AAL1 stops here.
    if (params.get('mfa')) return fail(WORK_IDENTITY_ERROR.MFA_REQUIRED);
    return redirectTo(request, withParam('/two-factor', 'redirectTo', withParam(self, 'mfa', '1')));
  }

  const secret = newFlowSecret();
  const { error: beginError } = await supabase.rpc('begin_work_identity_connect', {
    p_provider: provider,
    p_secret_digest: digest(secret),
  });
  if (beginError) return fail(errorCodeFrom(beginError.message));

  let providerUrl: string | null = null;
  try {
    providerUrl = await startOAuth(
      supabase,
      'link',
      provider,
      absoluteUrl(request, withParam('/auth/work/connect/callback', 'next', destination)),
    );
  } catch {
    providerUrl = null;
  }
  if (!providerUrl) return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);

  const response = NextResponse.redirect(providerUrl, 303);
  response.cookies.set(CONNECT_COOKIE, secret, flowCookieOptions(WORK_IDENTITY_CONNECT_TTL_SECONDS));
  return response;
}
