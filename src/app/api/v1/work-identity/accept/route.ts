import { NextResponse, type NextRequest } from 'next/server';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { ATTEMPT_COOKIE, decodeAttemptCookie, digest } from '@/lib/auth/workIdentity';
import { TOS_VERSION } from '@/lib/constants/legal';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { WORK_IDENTITY_FLAG, errorCodeFrom } from '@/app/auth/work/_shared';
import { workIdentityError } from '../_errors';

const MAX_DISPLAY_NAME = 120;

type AcceptResult = {
  deal_id: string | null;
  company_id: string;
  is_external: boolean;
  duplicate: boolean;
};

/**
 * Accept a work-identity invitation (#316 1g). Bound to the attempt cookie
 * this AAL2 session claimed; the RPC runs on the session client so
 * `auth.uid()` and the session are the caller's, and it performs the grant,
 * the binding and the audits in one transaction.
 */
export async function POST(request: NextRequest) {
  const gate = await requireFlag(WORK_IDENTITY_FLAG);
  if (gate) return gate;

  const auth = await requireApiUser({ allowInvited: true, forceAal2: true });
  if (!auth.ok) return auth.response;

  let displayName = '';
  let tosAccepted = false;
  try {
    const body = (await request.json()) as { displayName?: unknown; tosAccepted?: unknown };
    displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    tosAccepted = body.tosAccepted === true;
  } catch {
    // Malformed body: rejected below.
  }
  if (!tosAccepted) return jsonError('Accept the Terms of Service to continue', 400);
  if (!displayName || displayName.length > MAX_DISPLAY_NAME) {
    return jsonError('Enter your name as colleagues should see it', 400);
  }

  const attempt = decodeAttemptCookie(request.cookies.get(ATTEMPT_COOKIE)?.value);
  if (!attempt || !isUuid(attempt.attemptId)) return workIdentityError(WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED);

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  try {
    supabase = await createSupabaseServerClient();
  } catch {
    return jsonError('Server misconfigured', 503);
  }

  const { data, error } = await supabase.rpc('accept_work_identity_invite', {
    p_attempt_id: attempt.attemptId,
    p_secret_digest: digest(attempt.secret),
    p_terms_version: TOS_VERSION,
    p_display_name: displayName,
  });
  if (error) {
    const code = errorCodeFrom(error.message, WORK_IDENTITY_ERROR.PROVIDER_FAILED);
    if (code === WORK_IDENTITY_ERROR.PROVIDER_FAILED) {
      return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
    }
    return workIdentityError(code);
  }

  const result = data as AcceptResult;
  let dealCode: string | null = null;
  if (result.deal_id) {
    const { data: deal } = await auth.admin
      .from('deals')
      .select('code')
      .eq('id', result.deal_id)
      .maybeSingle();
    dealCode = (deal?.code as string | undefined) ?? null;
  }

  const response = NextResponse.json({
    dealId: result.deal_id,
    dealCode,
    duplicate: result.duplicate,
  });
  response.cookies.delete(ATTEMPT_COOKIE);
  return response;
}
