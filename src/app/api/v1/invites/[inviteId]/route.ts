import { NextResponse } from 'next/server';
import { jsonError, requireApiUser, isUuid } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { userCanManageInvite } from '@/lib/api/v1/access';
import { errorCodeOf } from '@/lib/errors/upstream';

/** Revoke a pending invite. The RPC flips status + audits atomically. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ inviteId: string }> },
) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { inviteId } = await params;
  if (!isUuid(inviteId)) return jsonError('Not found', 404);

  const { data: invite } = await auth.admin
    .from('invites')
    .select('id, company_id, deal_id, status')
    .eq('id', inviteId)
    .maybeSingle();
  if (!invite) return jsonError('Not found', 404);

  const authorized = await userCanManageInvite(auth.admin, auth.user.id, {
    companyId: invite.company_id,
    dealId: invite.deal_id,
  });
  if (!authorized) return jsonError('Forbidden', 403);

  const { error } = await auth.admin.rpc('revoke_invite', {
    p_invite_id: inviteId,
    p_actor: auth.user.id,
  });
  if (error) {
    if (error.message.includes('not_pending')) {
      return jsonError('Only a pending invite can be revoked', 409);
    }
    return jsonError(`Invite revoke failed (${errorCodeOf(error)})`, 500);
  }

  return NextResponse.json({ ok: true });
}
