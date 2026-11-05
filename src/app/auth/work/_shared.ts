import { combineChunks, stringFromBase64URL } from '@supabase/ssr';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolvePublicOrigin } from '@/lib/api/v1/publicOrigin';
import { getSupabaseConfig } from '@/lib/supabase/config';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import {
  WORK_IDENTITY_ERROR,
  type WorkIdentityErrorCode,
  type WorkIdentityProvider,
} from '@/lib/constants/workIdentity';

/**
 * Shared helpers for the work-identity routes (#316 section 4). Private to the
 * routes: the `_` prefix keeps this folder out of the router.
 */

export const WORK_IDENTITY_FLAG = 'work_identity_onboarding' as const;

/** A plain 404, matching how a route that never shipped would answer. */
export function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404 });
}

const OAUTH_SCOPES = 'openid email profile';

/**
 * The Supabase provider that brokers a firm provider. Google cannot be pointed
 * at a local issuer, so local and e2e stacks register the mock issuer as
 * `keycloak` and set WORK_IDENTITY_TEST_BROKER_PROVIDER=keycloak. That switch
 * maps BOTH providers to keycloak. GoTrue's azure provider does not need it: it
 * takes a `url`, and for a non-Microsoft host it clears its expected issuer
 * (supabase/auth `azure.go`), so the Microsoft journey runs the real provider
 * against the mock with the variable UNSET, and the keycloak substitution stays
 * as the fallback for it. The substitution applies only when Supabase itself is
 * on a loopback host: the hermetic e2e runs a production build (`next start`),
 * so NODE_ENV cannot be the guard, but no deployment talks to a loopback stack.
 */
export function brokerProvider(
  provider: WorkIdentityProvider,
  env: NodeJS.ProcessEnv = process.env,
): WorkIdentityProvider | 'keycloak' {
  return env.WORK_IDENTITY_TEST_BROKER_PROVIDER === 'keycloak' && isLoopbackUrl(env.NEXT_PUBLIC_SUPABASE_URL)
    ? 'keycloak'
    : provider;
}

function isLoopbackUrl(value: string | undefined): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value ?? '').hostname);
  } catch {
    return false;
  }
}

/**
 * Start a PKCE OAuth round trip from the server. The code verifier lands in
 * the @supabase/ssr cookie storage; only the provider URL comes back.
 * `organizationId` is the Google Workspace domain used as the `hd` hint.
 */
export async function startOAuth(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  mode: 'sign_in' | 'link',
  provider: WorkIdentityProvider,
  redirectTo: string,
  organizationId?: string | null,
): Promise<string | null> {
  const broker = brokerProvider(provider);
  const queryParams: Record<string, string> = { prompt: 'select_account' };
  if (broker === 'google' && organizationId) queryParams.hd = organizationId;
  const options = { redirectTo, scopes: OAUTH_SCOPES, queryParams, skipBrowserRedirect: true };
  const { data, error } =
    mode === 'sign_in'
      ? await supabase.auth.signInWithOAuth({ provider: broker, options })
      : await supabase.auth.linkIdentity({ provider: broker, options });
  if (error || !data?.url) return null;
  return data.url;
}

/**
 * Does this user hold a provider identity that is not bound to the firm (#316)?
 * Service-role RPC. Fails closed: an error, a throw or any answer other than an
 * explicit `false` counts as unbound, so the callback refuses rather than waves
 * a session through on an outage.
 */
export async function hasUnboundWorkIdentity(userId: string): Promise<boolean> {
  try {
    const { data, error } = await createSupabaseAdminClient().rpc('work_identity_has_unbound', {
      p_user: userId,
    });
    if (error) return true;
    return data !== false;
  } catch {
    return true;
  }
}

export function absoluteUrl(request: NextRequest, path: string): string {
  return new URL(path, resolvePublicOrigin(request)).toString();
}

export function redirectTo(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(absoluteUrl(request, path), 303);
}

/** Append `key=value` to an internal path that may already carry a query. */
export function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, 'https://conductia.internal');
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

/** The @supabase/ssr auth storage key; the PKCE verifier lives at `<key>-code-verifier`. */
export function codeVerifierCookieName(): string | null {
  const config = getSupabaseConfig();
  if (!config) return null;
  return `sb-${new URL(config.url).hostname.split('.')[0]}-auth-token-code-verifier`;
}

/**
 * Read the PKCE verifier that `linkIdentity` stored through @supabase/ssr:
 * a possibly chunked cookie, `base64-` + base64url of the JSON-encoded value,
 * optionally suffixed `/<redirectType>` by auth-js.
 */
export async function readCodeVerifier(
  getCookie: (name: string) => string | undefined,
): Promise<string | null> {
  const name = codeVerifierCookieName();
  if (!name) return null;
  const raw = await combineChunks(name, (chunk) => getCookie(chunk) ?? null);
  if (!raw) return null;
  try {
    const decoded = raw.startsWith('base64-') ? stringFromBase64URL(raw.slice(7)) : raw;
    const value = JSON.parse(decoded) as unknown;
    if (typeof value !== 'string' || !value) return null;
    return value.split('/')[0] || null;
  } catch {
    return null;
  }
}

/** Remove the verifier cookie and any chunks of it. */
export function clearCodeVerifier(response: NextResponse, names: string[]): void {
  const name = codeVerifierCookieName();
  if (!name) return;
  for (const cookie of names) {
    if (cookie === name || cookie.startsWith(`${name}.`)) response.cookies.delete(cookie);
  }
}

/** GoTrue's linkIdentity refusal for an account linked to a different user. */
export const GOTRUE_LINKED_ELSEWHERE = 'linked to another user';

/**
 * Database exception messages (and token-hook refusals) mapped to the browser
 * error codes whose copy lives in src/lib/auth/workIdentityCopy.ts. A code the
 * connect flow can return also needs a CONNECT_COPY entry there, or /profile
 * shows the generic connect failure.
 */
const DB_ERROR_TO_CODE: Record<string, WorkIdentityErrorCode> = {
  // Longest needles first where one contains another.
  work_identity_not_connected: WORK_IDENTITY_ERROR.NOT_CONNECTED,
  work_identity_already_connected: WORK_IDENTITY_ERROR.ALREADY_CONNECTED,
  work_identity_link_stale: WORK_IDENTITY_ERROR.LINK_STALE,
  work_identity_ambiguous: WORK_IDENTITY_ERROR.IDENTITY_AMBIGUOUS,
  work_identity_bound_elsewhere: WORK_IDENTITY_ERROR.WRONG_ACCOUNT,
  // GoTrue's linkIdentity refusals share the identity_already_exists code:
  // "...already linked to another user" vs "Identity is already linked" (this
  // user, resolved by the connect callback only, #406).
  [GOTRUE_LINKED_ELSEWHERE]: WORK_IDENTITY_ERROR.WRONG_ACCOUNT,
  identity_already_exists: WORK_IDENTITY_ERROR.WRONG_ACCOUNT,
  work_identity_mismatch: WORK_IDENTITY_ERROR.ORGANIZATION_MISMATCH,
  identity_provider_not_configured: WORK_IDENTITY_ERROR.PROVIDER_NOT_CONFIGURED,
  attempt_consumed: WORK_IDENTITY_ERROR.ATTEMPT_CONSUMED,
  attempt_claimed: WORK_IDENTITY_ERROR.ATTEMPT_CONSUMED,
  attempt_expired: WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  attempt_flow_mismatch: WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  attempt_invalid: WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  attempt_not_claimed: WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  invalid_secret: WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  session_not_live: WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  connect_intent_invalid: WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  connect_flow_invalid: WORK_IDENTITY_ERROR.PROVIDER_FAILED,
  credential_mismatch: WORK_IDENTITY_ERROR.INVITE_SUPERSEDED,
  invite_expired: WORK_IDENTITY_ERROR.INVITE_EXPIRED,
  invite_not_pending: WORK_IDENTITY_ERROR.INVITE_REVOKED,
  invite_not_found: WORK_IDENTITY_ERROR.INVITE_REVOKED,
  invite_not_sent: WORK_IDENTITY_ERROR.INVITE_CONTEXT_MISSING,
  invite_method_mismatch: WORK_IDENTITY_ERROR.INVITE_CONTEXT_MISSING,
  email_mismatch: WORK_IDENTITY_ERROR.WRONG_ACCOUNT,
  email_unverified: WORK_IDENTITY_ERROR.EMAIL_UNVERIFIED,
  organization_mismatch: WORK_IDENTITY_ERROR.ORGANIZATION_MISMATCH,
  account_not_eligible: WORK_IDENTITY_ERROR.EXISTING_ACCOUNT,
  profile_not_contained: WORK_IDENTITY_ERROR.EXISTING_ACCOUNT,
  inviter_not_authorized: WORK_IDENTITY_ERROR.INVITER_AUTHORITY_LOST,
  invite_other_firm: WORK_IDENTITY_ERROR.INVITE_OTHER_FIRM,
  mfa_required: WORK_IDENTITY_ERROR.MFA_REQUIRED,
  account_suspended: WORK_IDENTITY_ERROR.ACCOUNT_SUSPENDED,
  no_invitation: WORK_IDENTITY_ERROR.NO_INVITATION,
};

function matchErrorCode(message: string | null | undefined): WorkIdentityErrorCode | null {
  if (!message) return null;
  for (const [needle, code] of Object.entries(DB_ERROR_TO_CODE)) {
    if (message.includes(needle)) return code;
  }
  return null;
}

/** First known code found in an error message, else `fallback`. */
export function errorCodeFrom(
  message: string | null | undefined,
  fallback: WorkIdentityErrorCode = WORK_IDENTITY_ERROR.PROVIDER_FAILED,
): WorkIdentityErrorCode {
  return matchErrorCode(message) ?? fallback;
}

/** Map a provider/hook error returned on the OAuth callback URL. */
export function callbackErrorCode(params: URLSearchParams): WorkIdentityErrorCode {
  const error = params.get('error');
  const description = params.get('error_description');
  const known = matchErrorCode(`${description ?? ''} ${params.get('error_code') ?? ''}`);
  if (known) return known;
  if (error === 'access_denied') return WORK_IDENTITY_ERROR.CONSENT_CANCELED;
  return WORK_IDENTITY_ERROR.PROVIDER_FAILED;
}

const GONE: ReadonlySet<WorkIdentityErrorCode> = new Set([
  WORK_IDENTITY_ERROR.ATTEMPT_CONSUMED,
  WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED,
  WORK_IDENTITY_ERROR.INVITE_SUPERSEDED,
  WORK_IDENTITY_ERROR.INVITE_EXPIRED,
  WORK_IDENTITY_ERROR.INVITE_REVOKED,
]);

/** HTTP status for an API error code: gone flows 410, everything else denied 403. */
export function httpStatusFor(code: WorkIdentityErrorCode): number {
  return GONE.has(code) ? 410 : 403;
}
