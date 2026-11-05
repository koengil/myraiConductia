import type { SupabaseClient } from '@supabase/supabase-js';
import { isWorkIdentityUser } from '@/lib/auth/mfaPolicy';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';

/**
 * Fail-closed check for work-identity sessions (#316, Option B).
 *
 * `public.work_identity_access_token_hook` stamps `work_identity_hook = 1`
 * into every access token it issues. A project that does not run the hook
 * issues tokens without it, so a work-identity session whose token lacks the
 * claim was not admitted by the hook and must not be served.
 *
 * Edge-safe: no node:crypto or Buffer, because middleware imports this file.
 */

/** The claim the hook adds to every token it issues. */
export const WORK_IDENTITY_HOOK_CLAIM = 'work_identity_hook';

/** The error code every choke point reports when the check refuses a session. */
export const WORK_IDENTITY_HOOK_REFUSAL = WORK_IDENTITY_ERROR.NOT_CONNECTED;

type HookAuthClient = {
  auth: Pick<SupabaseClient['auth'], 'getSession' | 'refreshSession' | 'signOut'>;
};

/**
 * Does the access token carry the hook claim? Decodes the JWT payload only:
 * no signature check and no network call, because the caller has just had
 * `getUser()` validate this same session with GoTrue. Absent, malformed or
 * non-JSON tokens are false.
 */
export function hasWorkIdentityHookClaim(accessToken?: string): boolean {
  if (!accessToken) return false;
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (typeof payload !== 'object' || payload === null) return false;
    return (payload as Record<string, unknown>)[WORK_IDENTITY_HOOK_CLAIM] === 1;
  } catch {
    return false;
  }
}

async function currentAccessToken(supabase: {
  auth: Pick<SupabaseClient['auth'], 'getSession'>;
}): Promise<string | undefined> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token;
  } catch {
    return undefined;
  }
}

/**
 * The read-only form, for a Server Component, where cookie writes are
 * discarded: no refresh and no sign-out, because a rotated refresh token that
 * is never stored would end the session at its next use. The middleware runs
 * `enforceWorkIdentityHook` on the same request first, so a token that one
 * refresh could fix arrives here already refreshed.
 */
export async function checkWorkIdentityHook(
  supabase: { auth: Pick<SupabaseClient['auth'], 'getSession'> },
  user: { app_metadata?: Record<string, unknown> },
): Promise<'ok' | 'refused'> {
  if (!isWorkIdentityUser(user)) return 'ok';
  return hasWorkIdentityHookClaim(await currentAccessToken(supabase)) ? 'ok' : 'refused';
}

/**
 * Call right after `getUser()`, before any AAL logic, where the response can
 * carry cookies (middleware, a Route Handler). Users without an
 * external provider return 'ok' untouched (no session read, no network call).
 * A token without the claim gets one refresh (a token issued before the hook
 * claim shipped picks it up there). If the new token still lacks it, the
 * session is refused and signed out locally (`scope: 'local'` ends only this
 * session, never the user's others).
 */
export async function enforceWorkIdentityHook(
  supabase: HookAuthClient,
  user: { app_metadata?: Record<string, unknown> },
): Promise<'ok' | 'refused'> {
  if (!isWorkIdentityUser(user)) return 'ok';
  if (hasWorkIdentityHookClaim(await currentAccessToken(supabase))) return 'ok';

  try {
    const { data } = await supabase.auth.refreshSession();
    if (hasWorkIdentityHookClaim(data.session?.access_token)) return 'ok';
  } catch {
    // A failed refresh is a refusal, not an outage pass-through.
  }

  console.error('work_identity_hook_missing');
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // The refusal stands even if the local sign-out could not complete.
  }
  return 'refused';
}
