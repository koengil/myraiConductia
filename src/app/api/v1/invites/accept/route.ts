import { NextResponse } from 'next/server';
import { inviteContextMissing, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { workIdentityErrorCopy } from '@/lib/auth/workIdentity';
import { TOS_VERSION } from '@/lib/constants/legal';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Finalize an invite. The ONE endpoint reachable while users.status is
 * 'invited' (allowInvited). The RPC runs on the SESSION-BOUND client so
 * auth.uid() is the accepting user (cr-plan-v2 5.1); invite id + nonce come
 * from the session user's own metadata (set server-side at link generation),
 * never from the request body.
 *
 * The password travels here (not through supabase.auth.updateUser first) so
 * the RPC can set it, write the terms attest, promote the contained profile
 * and retire competing sessions in ONE transaction bound to the session that
 * verified the mailbox code (plan 1a). It is passed only as an RPC argument
 * and never logged.
 */

/** Mirrors supabase/config.toml minimum_password_length; the RPC re-checks. */
const MIN_PASSWORD_LENGTH = 6;
/** bcrypt input limit, also enforced by GoTrue and the RPC. */
const MAX_PASSWORD_BYTES = 72;

function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH
    && new TextEncoder().encode(password).length <= MAX_PASSWORD_BYTES;
}
export async function POST(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser({ allowInvited: true, allowAal1: true });
  if (!auth.ok) return auth.response;

  let displayName: string | null = null;
  let tosAccepted = false;
  let password = '';
  try {
    const body = (await request.json()) as {
      displayName?: string;
      tosAccepted?: boolean;
      password?: unknown;
    };
    displayName = body.displayName?.trim() || null;
    tosAccepted = body.tosAccepted === true;
    password = typeof body.password === 'string' ? body.password : '';
  } catch {
    // Malformed body: tosAccepted stays false and is rejected below.
  }
  if (!tosAccepted) {
    return jsonError('Accept the Terms of Service to continue', 400);
  }
  if (!isAcceptablePassword(password)) {
    return NextResponse.json(
      {
        error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} bytes.`,
        code: 'weak_password',
      },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const metadata = (user?.user_metadata ?? {}) as {
    invite_id?: string;
    credential_nonce?: string;
  };
  if (!metadata.invite_id || !metadata.credential_nonce) {
    return inviteContextMissing();
  }

  // The terms attest is written inside accept_invite, so an audit failure
  // aborts activation (AC8) instead of leaving an orphan attest row.
  const { data, error } = await supabase.rpc('accept_invite', {
    p_invite_id: metadata.invite_id,
    p_nonce: metadata.credential_nonce,
    p_password: password,
    p_tos_version: TOS_VERSION,
    p_display_name: displayName,
  });

  if (error) {
    const message = error.message;
    if (message.includes('invite_expired')) return jsonError('This invitation expired', 410);
    if (message.includes('invite_not_pending')) {
      return jsonError('This invitation is no longer open', 410);
    }
    if (message.includes('credential_mismatch')) {
      return jsonError('This link was superseded. Ask for a fresh invitation.', 410);
    }
    if (message.includes('email_mismatch') || message.includes('tenant_mismatch')) {
      return jsonError('This invitation belongs to a different account', 409);
    }
    if (message.includes('invite_not_found')) return jsonError('Not found', 404);
    if (message.includes('weak_password')) {
      return NextResponse.json(
        {
          error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} bytes.`,
          code: 'weak_password',
        },
        { status: 400 },
      );
    }
    if (message.includes('challenge_session_mismatch')) {
      return NextResponse.json(
        {
          error: 'Verify the invitation code in this browser before accepting.',
          code: 'challenge_session_mismatch',
        },
        { status: 409 },
      );
    }
    if (message.includes('invite_method_mismatch')) {
      return NextResponse.json(
        {
          error: 'This invitation uses your firm sign-in. Open the invitation email to continue.',
          code: 'invite_method_mismatch',
        },
        { status: 409 },
      );
    }
    // #408: an invitation never moves an active user to another firm.
    if (message.includes('invite_other_firm')) {
      return NextResponse.json(
        {
          error: workIdentityErrorCopy(WORK_IDENTITY_ERROR.INVITE_OTHER_FIRM).message,
          code: 'invite_other_firm',
        },
        { status: 409 },
      );
    }
    // Acceptance re-derives the inviter's seat (#296): a suspended inviter, or
    // one who lost the permission the invite was issued under, can no longer
    // grant it. Same copy the work-identity path shows.
    if (message.includes('inviter_not_authorized')) {
      return NextResponse.json(
        {
          error: workIdentityErrorCopy(WORK_IDENTITY_ERROR.INVITER_AUTHORITY_LOST).message,
          code: 'inviter_not_authorized',
        },
        { status: 403 },
      );
    }
    if (message.includes('invite_not_verified')) {
      return jsonError('Verify the invitation code before accepting', 409);
    }
    if (message.includes('must retain at least one active director')) {
      return NextResponse.json(
        {
          error: 'This company needs an active director. Ask a firm admin to send a new Company Director invitation.',
          code: 'company_requires_director',
        },
        { status: 409 },
      );
    }
    // Never echo the raw database message: it could quote an argument.
    console.error('invite acceptance failed', { userId: auth.user.id });
    return jsonError('Unable to accept this invitation. Try again.', 500);
  }

  const result = data as { deal_id: string | null; company_id: string; is_external: boolean };
  // Project URLs address deals by human-readable code, not UUID — hand the
  // client the code so the post-accept landing renders the real deal.
  let dealCode: string | null = null;
  if (result.deal_id) {
    const { data: deal } = await auth.admin
      .from('deals')
      .select('code')
      .eq('id', result.deal_id)
      .maybeSingle();
    dealCode = (deal?.code as string | undefined) ?? null;
  }
  return NextResponse.json({
    dealId: result.deal_id,
    dealCode,
    companyId: result.company_id,
    isExternal: result.is_external,
  });
}

