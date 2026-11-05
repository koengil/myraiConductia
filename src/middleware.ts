import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isMfaRequiredForUser } from '@/lib/auth/mfaPolicy';
import { safeAuthDestination } from '@/lib/auth/redirect';
import {
  WORK_IDENTITY_HOOK_REFUSAL,
  enforceWorkIdentityHook,
} from '@/lib/auth/workIdentityHook';
import { getSupabaseConfig } from '@/lib/supabase/config';
import { FREE_TEXT_KEYS } from '@/lib/url/freeTextKeys';

// A legacy link can carry a person or a search term in its query (#331). The
// auth redirects drop those keys rather than replay them into a new URL.
function dropFreeText(params: URLSearchParams): boolean {
  const keys = [...new Set(params.keys())].filter((key) => FREE_TEXT_KEYS.has(key.toLowerCase()));
  keys.forEach((key) => params.delete(key));
  return keys.length > 0;
}

const TWO_FACTOR_PATH = '/two-factor';

function authDestination(nextUrl: URL): string {
  const params = new URLSearchParams(nextUrl.search);
  const search = dropFreeText(params) ? (params.toString() ? `?${params}` : '') : nextUrl.search;
  return safeAuthDestination(`${nextUrl.pathname}${search}`);
}

/**
 * Platform auth boundary. Protected browser routes require an authenticated
 * Supabase user at AAL2. If Supabase is not configured, the gate is a no-op in
 * local dev only; staging and production fail closed.
 */
export async function middleware(request: NextRequest) {
  const config = getSupabaseConfig();
  if (!config) {
    const appEnv = process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
    if (appEnv === 'staging' || appEnv === 'prod') {
      return new NextResponse('Authentication service unavailable', { status: 503 });
    }
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Every redirect carries the cookies the client wrote on this request: a
  // refreshed session (its refresh token is single use) or a local sign-out.
  const redirect = (url: URL) => {
    const redirected = NextResponse.redirect(url);
    response.cookies.getAll().forEach((cookie) => redirected.cookies.set(cookie));
    return redirected;
  };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // /two-factor is matched only for the hook check below: the page sends an
  // anonymous visitor to sign-in itself, and the AAL redirect would loop.
  const twoFactor = request.nextUrl.pathname === TWO_FACTOR_PATH;

  if (!user) {
    if (twoFactor) return response;
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    dropFreeText(url.searchParams);
    url.searchParams.set('redirectTo', authDestination(request.nextUrl));
    return redirect(url);
  }

  // Before any AAL logic: a work-identity session whose token the hook did not
  // issue is refused, whatever its assurance level (#316).
  if ((await enforceWorkIdentityHook(supabase, user)) === 'refused') {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = '';
    url.searchParams.set('error', WORK_IDENTITY_HOOK_REFUSAL);
    return redirect(url);
  }

  if (twoFactor) return response;

  if (isMfaRequiredForUser(user)) {
    const { data: assurance, error: assuranceError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || assurance.currentLevel !== 'aal2') {
      const url = request.nextUrl.clone();
      url.pathname = TWO_FACTOR_PATH;
      url.search = '';
      url.searchParams.set('redirectTo', authDestination(request.nextUrl));
      return redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: [
    '/',
    '/((?!api|v1|sign-in|sign-out|accept-invite|join|auth/work|terms|privacy|dev-api|dev-primitives|conductia/email/|_next/static|_next/image|favicon.ico|icon.svg).*)',
  ],
};
