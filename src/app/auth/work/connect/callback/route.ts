import type { NextRequest } from 'next/server';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { safeAuthDestination } from '@/lib/auth/redirect';
import { PROFILE_CONNECT_DESTINATION } from '@/lib/auth/workConnect';
import { WORK_IDENTITY_HOOK_REFUSAL, enforceWorkIdentityHook } from '@/lib/auth/workIdentityHook';
import { CONNECT_COOKIE, digest, flowCookieOptions } from '@/lib/auth/workIdentity';
import { WORK_IDENTITY_COOKIE, WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import {
  GOTRUE_LINKED_ELSEWHERE,
  WORK_IDENTITY_FLAG,
  callbackErrorCode,
  clearCodeVerifier,
  errorCodeFrom,
  notFound,
  readCodeVerifier,
  redirectTo,
  withParam,
} from '../../_shared';

/**
 * Connect callback (#316 1e). The code is NOT exchanged: the original AAL2
 * session hands the auth code and our PKCE verifier to
 * `complete_work_identity_connect`, which proves the link came from this
 * session's own `linkIdentity` before binding it.
 */
export async function GET(request: NextRequest) {
  if (!(await isFlagEnabled(WORK_IDENTITY_FLAG))) return notFound();

  const params = request.nextUrl.searchParams;
  const destination = safeAuthDestination(params.get('next'));
  const cookieNames = request.cookies.getAll().map((cookie) => cookie.name);
  const finish = (path: string) => {
    const response = redirectTo(request, path);
    response.cookies.delete(CONNECT_COOKIE);
    // Any earlier unread success proof dies here; only a fresh success re-sets it.
    response.cookies.delete(WORK_IDENTITY_COOKIE.CONNECTED);
    clearCodeVerifier(response, cookieNames);
    return response;
  };
  const fail = (code: string) => finish(withParam(destination, 'error', code));

  // A connect secret is a bare base64url token; an attempt cookie value
  // (`<id>.<secret>`) or anything else is rejected outright. A failed callback
  // releases nothing (#406): the cookie is shared across tabs and may belong to
  // the winning connect; a stray left behind keeps Connect in the menu.
  const secret = request.cookies.get(CONNECT_COOKIE)?.value;
  if (!secret || !/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
    return fail(WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED);
  }
  if (params.get('error')) {
    const description = params.get('error_description') ?? '';
    // "...already linked to another user" stays wrong_account (shared mapping).
    if (description.includes('Identity is already linked') && !description.includes(GOTRUE_LINKED_ELSEWHERE)) {
      return fail(await linkRefusal());
    }
    return fail(callbackErrorCode(params));
  }
  const code = params.get('code');
  const verifier = await readCodeVerifier((name) => request.cookies.get(name)?.value);
  if (!code || !verifier) return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return fail(WORK_IDENTITY_ERROR.PROVIDER_FAILED);
  }

  // As on the connect start: a work-identity session whose token the hook did
  // not stamp binds nothing (#316). The middleware does not run here. A
  // missing session is left to the RPC, which refuses it as before.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && (await enforceWorkIdentityHook(supabase, user)) === 'refused') {
    return fail(WORK_IDENTITY_HOOK_REFUSAL);
  }

  const { data, error } = await supabase.rpc('complete_work_identity_connect', {
    p_secret_digest: digest(secret),
    p_auth_code: code,
    p_code_verifier: verifier,
  });
  if (error) return fail(errorCodeFrom(error.message));
  // The RPC commits refusals (release, consumed intent) and reports them in-band.
  const result = data as { connected?: boolean; error?: string } | null;
  if (!result?.connected) return fail(errorCodeFrom(result?.error ?? 'work_identity_mismatch'));

  const response = finish(withParam(destination, 'connected', '1'));
  // Proof for /profile that this connect just completed: a crafted or replayed
  // ?connected=1 has no cookie, and the page clears it after reading. Only a
  // /profile return gets it; /join never reads it, so it cannot leak there.
  if (new URL(destination, 'http://x').pathname.replace(/\/$/, '') === PROFILE_CONNECT_DESTINATION) {
    response.cookies.set(WORK_IDENTITY_COOKIE.CONNECTED, '1', { ...flowCookieOptions(60), httpOnly: false });
  }
  return response;
}

/**
 * What a GoTrue "Identity is already linked" refusal meant (#406:
 * work_identity_link_refusal, read only): the bound current account, a bound
 * account from before a move, or a stray. Connect again when it cannot tell.
 */
async function linkRefusal(): Promise<string> {
  const unknown = WORK_IDENTITY_ERROR.IDENTITY_AMBIGUOUS;
  try {
    const supabase = await createSupabaseServerClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return unknown;
    const { data, error } = await createSupabaseAdminClient().rpc('work_identity_link_refusal', {
      p_user: auth.user.id,
    });
    return error ? unknown : errorCodeFrom(data as string | null, unknown);
  } catch {
    return unknown;
  }
}
