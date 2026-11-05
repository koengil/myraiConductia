import { NextResponse } from 'next/server';
import { firmMailAccess } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * PATCH /api/v1/inbox/{messageId} — mark an inbound message read/unread.
 * Same bank-side gate as the inbox list; scoped to the caller's tenant.
 */
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ messageId: string }> },
) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const access = await firmMailAccess(auth.admin, auth.user.id);
  if (!access.ok || !access.tenantId) return jsonError('Forbidden', 403);

  let body: { read?: unknown };
  try {
    body = (await request.json()) as { read?: unknown };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (typeof body.read !== 'boolean') return jsonError('read must be a boolean', 400);

  const { messageId } = await ctx.params;
  const { data, error } = await auth.admin
    .from('inbound_messages')
    .update({ read_at: body.read ? new Date().toISOString() : null })
    .eq('id', messageId)
    .eq('tenant_id', access.tenantId)
    .select('id')
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError('Message not found', 404);

  return NextResponse.json({ ok: true });
}
