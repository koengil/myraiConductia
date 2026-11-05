import { NextResponse } from 'next/server';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';

type RouteContext = { params: Promise<{ notificationId: string }> };

/**
 * Mark one of the caller's notifications read (sets read_at). The caller must
 * be the recipient — the update is scoped to (id, recipient_id), so a
 * non-recipient simply matches zero rows and gets a 404.
 *   PATCH /api/v1/notifications/{id}   body: { read?: boolean } (default true)
 */
export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { notificationId } = await context.params;

  let read = true;
  try {
    const body = (await request.json()) as { read?: boolean };
    if (typeof body?.read === 'boolean') read = body.read;
  } catch {
    // No/invalid body — default to marking read.
  }

  const { data, error } = await auth.admin
    .from('notifications')
    .update({ read_at: read ? new Date().toISOString() : null })
    .eq('id', notificationId)
    .eq('recipient_id', auth.user.id)
    .select('id, deal_id, event_type, payload, read_at, created_at')
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!data) return jsonError('Notification not found', 404);

  return NextResponse.json({ notification: data });
}
