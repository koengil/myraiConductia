import { NextResponse } from 'next/server';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';

/**
 * The caller's notifications, newest first.
 *   GET /api/v1/notifications          — all
 *   GET /api/v1/notifications?unread=1 — unread only (read_at is null)
 *
 * Scoped to the authenticated recipient (the DB RLS policy enforces the same;
 * the app-layer filter is the belt to that suspenders).
 */
export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get('unread') === '1';

  let builder = auth.admin
    .from('notifications')
    .select('id, deal_id, event_type, payload, read_at, created_at')
    .eq('recipient_id', auth.user.id);

  if (unreadOnly) builder = builder.is('read_at', null);

  const { data, error } = await builder.order('created_at', { ascending: false });
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ notifications: data ?? [] });
}
