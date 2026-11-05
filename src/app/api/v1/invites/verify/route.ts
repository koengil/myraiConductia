import { NextResponse } from 'next/server';
import {
  digestInviteChallengeCode,
  isInviteChallengeCode,
} from '@/lib/api/v1/inviteChallenge';
import { inviteContextMissing, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;
  const auth = await requireApiUser({ allowInvited: true, allowAal1: true });
  if (!auth.ok) return auth.response;

  let code: unknown;
  try {
    ({ code } = (await request.json()) as { code?: unknown });
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!isInviteChallengeCode(code)) {
    return jsonError('Enter the six-digit verification code', 400);
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

  let digest: string;
  try {
    digest = digestInviteChallengeCode(code);
  } catch {
    return jsonError('Invite verification is not configured', 500);
  }

  const { data, error } = await supabase.rpc('verify_invite_challenge', {
    p_invite_id: metadata.invite_id,
    p_nonce: metadata.credential_nonce,
    p_code_digest: digest,
  });
  if (error) {
    if (error.message.includes('already_verified')) {
      return NextResponse.json({ verified: true, attemptsRemaining: 5, locked: false });
    }
    return NextResponse.json(
      {
        verified: false,
        attemptsRemaining: 0,
        locked: error.message.includes('locked'),
      },
      { status: 400 },
    );
  }

  const result = data as {
    verified: boolean;
    attempts_remaining?: number;
    locked?: boolean;
  };
  const response = {
    verified: result.verified === true,
    attemptsRemaining: result.attempts_remaining ?? (result.verified ? 5 : 0),
    locked: result.locked === true,
  };
  return NextResponse.json(response, { status: response.verified ? 200 : 400 });
}
