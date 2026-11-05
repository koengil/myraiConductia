import { NextResponse, type NextRequest } from 'next/server';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { isUuid } from '@/lib/api/v1/http';
import {
  ATTEMPT_COOKIE,
  digest,
  encodeAttemptCookie,
  flowCookieOptions,
  newFlowSecret,
} from '@/lib/auth/workIdentity';
import {
  WORK_IDENTITY_ATTEMPT_TTL_SECONDS,
  WORK_IDENTITY_ERROR,
  isWorkIdentityProvider,
} from '@/lib/constants/workIdentity';
import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import {
  WORK_IDENTITY_FLAG,
  absoluteUrl,
  errorCodeFrom,
  notFound,
  redirectTo,
  startOAuth,
} from '../_shared';

type AttemptRow = { attempt_id: string; provider: string; organization_id: string | null };

/**
 * Invitation start (#316 section 4): open a bound attempt for `?invite&k`,
 * keep its secret in an httpOnly cookie, and send the browser to the firm's
 * provider through a server-side PKCE OAuth start.
 */
export async function GET(request: NextRequest) {
  if (!(await isFlagEnabled(WORK_IDENTITY_FLAG))) return notFound();

  const invite = request.nextUrl.searchParams.get('invite') ?? '';
  const nonce = request.nextUrl.searchParams.get('k') ?? '';
  const joinPath = (code: string) =>
    `/join?${new URLSearchParams({ invite, k: nonce, error: code }).toString()}`;
  if (!isUuid(invite) || !isUuid(nonce)) {
    return redirectTo(request, `/join?error=${WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED}`);
  }

  const secret = newFlowSecret();
  let row: AttemptRow | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient().rpc('start_work_identity_attempt', {
      p_invite_id: invite,
      p_nonce: nonce,
      p_secret_digest: digest(secret),
    });
    if (error) {
      return redirectTo(request, joinPath(errorCodeFrom(error.message)));
    }
    row = (Array.isArray(data) ? data[0] : data) as AttemptRow | null;
  } catch {
    return redirectTo(request, joinPath(WORK_IDENTITY_ERROR.PROVIDER_FAILED));
  }
  if (!row?.attempt_id || !isWorkIdentityProvider(row.provider)) {
    return redirectTo(request, joinPath(WORK_IDENTITY_ERROR.PROVIDER_NOT_CONFIGURED));
  }

  let providerUrl: string | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    providerUrl = await startOAuth(
      supabase,
      'sign_in',
      row.provider,
      absoluteUrl(request, '/auth/work/callback'),
      row.organization_id,
    );
  } catch {
    providerUrl = null;
  }
  if (!providerUrl) return redirectTo(request, joinPath(WORK_IDENTITY_ERROR.PROVIDER_FAILED));

  // Bind the attempt to this OAuth flow's PKCE challenge, so only a session
  // exchanged with this flow's verifier can claim it (F14).
  const challenge = new URL(providerUrl).searchParams.get('code_challenge');
  const { error: bindError } = challenge
    ? await createSupabaseAdminClient().rpc('bind_work_identity_attempt_flow', {
        p_attempt_id: row.attempt_id,
        p_secret_digest: digest(secret),
        p_code_challenge: challenge,
      })
    : { error: { message: 'attempt_flow_mismatch' } };
  if (bindError) return redirectTo(request, joinPath(WORK_IDENTITY_ERROR.PROVIDER_FAILED));

  const response = NextResponse.redirect(providerUrl, 303);
  response.cookies.set(
    ATTEMPT_COOKIE,
    encodeAttemptCookie(row.attempt_id, secret),
    flowCookieOptions(WORK_IDENTITY_ATTEMPT_TTL_SECONDS),
  );
  return response;
}
