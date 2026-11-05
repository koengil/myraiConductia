import { NextResponse, type NextRequest } from 'next/server';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { safeAuthDestination } from '@/lib/auth/redirect';
import { ATTEMPT_COOKIE } from '@/lib/auth/workIdentity';
import { WORK_IDENTITY_ERROR, isWorkIdentityProvider } from '@/lib/constants/workIdentity';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  WORK_IDENTITY_FLAG,
  absoluteUrl,
  notFound,
  redirectTo,
  startOAuth,
  withParam,
} from '../_shared';

/**
 * Returning sign-in with a bound work account (#316 section 4). No attempt is
 * opened, so this path can never create a membership; the token hook decides
 * whether the provider account may hold a session at all.
 */
export async function GET(request: NextRequest) {
  if (!(await isFlagEnabled(WORK_IDENTITY_FLAG))) return notFound();

  const provider = request.nextUrl.searchParams.get('provider');
  const destination = safeAuthDestination(request.nextUrl.searchParams.get('redirectTo'));
  const failure = withParam('/sign-in', 'error', WORK_IDENTITY_ERROR.PROVIDER_FAILED);
  if (!isWorkIdentityProvider(provider)) return redirectTo(request, failure);

  let providerUrl: string | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    providerUrl = await startOAuth(
      supabase,
      'sign_in',
      provider,
      absoluteUrl(request, withParam('/auth/work/callback', 'next', destination)),
    );
  } catch {
    providerUrl = null;
  }
  if (!providerUrl) return redirectTo(request, failure);

  const response = NextResponse.redirect(providerUrl, 303);
  // A stale invitation attempt must never be claimed by a plain sign-in.
  response.cookies.delete(ATTEMPT_COOKIE);
  return response;
}
