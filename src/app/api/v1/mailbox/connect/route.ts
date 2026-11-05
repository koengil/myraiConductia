import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { jsonError, requireApiUser, safeInternalPath } from '@/lib/api/v1/http';
import { graphAuthUrl, graphConfigured } from '@/lib/email/graph';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * GET /api/v1/mailbox/connect — start the OAuth consent for the caller's
 * Microsoft 365 mailbox. 302 to the Microsoft authorize page; the CSRF state
 * and the post-connect return path ride in short-lived httpOnly cookies and
 * are checked by the callback.
 */
export async function GET(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  if (!graphConfigured()) {
    return jsonError('Mailbox connection not configured (Azure app env missing)', 503);
  }

  const url = new URL(request.url);
  const next = safeInternalPath(url.searchParams.get('next'));

  const state = randomUUID();
  const res = NextResponse.redirect(graphAuthUrl(state));
  const cookie = { httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge: 600 };
  res.cookies.set('mailbox_oauth_state', state, cookie);
  res.cookies.set('mailbox_next', next, cookie);
  return res;
}
