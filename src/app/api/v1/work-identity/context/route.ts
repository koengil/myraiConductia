import { NextResponse, type NextRequest } from 'next/server';
import { isUuid, requireApiUser } from '@/lib/api/v1/http';
import { fetchInviteEmailContext } from '@/lib/api/v1/inviteDelivery';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { ATTEMPT_COOKIE, decodeAttemptCookie, digest } from '@/lib/auth/workIdentity';
import { TOS_VERSION } from '@/lib/constants/legal';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';
import { WORK_IDENTITY_FLAG } from '@/app/auth/work/_shared';
import { workIdentityError } from '../_errors';

type AttemptRow = {
  invite_id: string;
  secret_digest: string;
  claimed_user_id: string | null;
  expires_at: string;
  consumed_at: string | null;
};

type InviteRow = {
  company_id: string;
  company_role: string | null;
  deal_id: string | null;
  deal_role: string | null;
  invited_by: string;
};

/**
 * What the confirmation screen shows (#316 section 4): firm, role, deal and a
 * prefilled name, for the attempt this AAL2 session claimed. Read-only; the
 * acceptance RPC re-checks everything.
 */
export async function GET(request: NextRequest) {
  const gate = await requireFlag(WORK_IDENTITY_FLAG);
  if (gate) return gate;

  const auth = await requireApiUser({ allowInvited: true, forceAal2: true });
  if (!auth.ok) return auth.response;

  const attempt = decodeAttemptCookie(request.cookies.get(ATTEMPT_COOKIE)?.value);
  if (!attempt || !isUuid(attempt.attemptId)) return workIdentityError(WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED);

  const { data: row, error } = await auth.admin
    .from('work_identity_attempts')
    .select('invite_id, secret_digest, claimed_user_id, expires_at, consumed_at')
    .eq('id', attempt.attemptId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: 'Unable to load the invitation' }, { status: 500 });
  const found = row as AttemptRow | null;
  if (
    !found ||
    found.secret_digest !== digest(attempt.secret) ||
    found.claimed_user_id !== auth.user.id ||
    new Date(found.expires_at).getTime() < Date.now()
  ) {
    return workIdentityError(WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED);
  }
  if (found.consumed_at) return workIdentityError(WORK_IDENTITY_ERROR.ATTEMPT_CONSUMED);

  const { data: inviteRow, error: inviteError } = await auth.admin
    .from('invites')
    .select('company_id, company_role, deal_id, deal_role, invited_by')
    .eq('id', found.invite_id)
    .maybeSingle();
  const invite = inviteRow as InviteRow | null;
  if (inviteError || !invite) {
    return NextResponse.json({ error: 'Unable to load the invitation' }, { status: 500 });
  }

  const [context, authUser] = await Promise.all([
    fetchInviteEmailContext(auth.admin, invite.invited_by, invite.company_id, invite.deal_id),
    auth.admin.auth.admin.getUserById(auth.user.id),
  ]);
  const metadata = (authUser.data.user?.user_metadata ?? {}) as Record<string, unknown>;
  const suggested = [metadata.full_name, metadata.name].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );

  return NextResponse.json({
    email: auth.user.email,
    displayName: suggested?.trim() ?? '',
    inviterName: context.inviterName,
    companyName: context.companyName,
    dealCodename: context.dealCodename,
    companyRole: invite.company_role,
    dealRole: invite.deal_role,
    termsVersion: TOS_VERSION,
  });
}
