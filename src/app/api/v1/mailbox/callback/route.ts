import { NextResponse } from 'next/server';
import { requireApiUser, safeInternalPath } from '@/lib/api/v1/http';
import { exchangeGraphCode, graphConfigured, graphProfile } from '@/lib/email/graph';
import { encryptTokens } from '@/lib/email/tokenCrypto';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * GET /api/v1/mailbox/callback — the OAuth return leg. Validates the CSRF
 * state cookie, exchanges the code, reads the mailbox identity from Graph,
 * stores the tokens ENCRYPTED (one connection per user, upsert), and returns
 * to where the user started (?mailbox=connected|error for the settings UI).
 */

function backTo(request: Request, next: string, outcome: 'connected' | 'error') {
  const url = new URL(safeInternalPath(next), new URL(request.url).origin);
  url.searchParams.set('mailbox', outcome);
  const res = NextResponse.redirect(url);
  res.cookies.delete('mailbox_oauth_state');
  res.cookies.delete('mailbox_next');
  return res;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export async function GET(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const next = cookieValue(request, 'mailbox_next') ?? '/';
  if (!graphConfigured()) return backTo(request, next, 'error');

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expectedState = cookieValue(request, 'mailbox_oauth_state');
  if (!code || !state || !expectedState || state !== expectedState) {
    return backTo(request, next, 'error');
  }

  const tokens = await exchangeGraphCode(code);
  if (!tokens) return backTo(request, next, 'error');

  const profile = await graphProfile(tokens.accessToken);
  if (!profile) return backTo(request, next, 'error');

  // One connection per user, so this may land on a Google row: reset the
  // columns only a Google connection sets, or a revoked Google row would keep
  // status 'revoked' beside fresh tokens and fail the status/token CHECK.
  const { error } = await auth.admin.from('mailbox_connections').upsert(
    {
      user_id: auth.user.id,
      provider: 'microsoft',
      email: profile.email,
      tokens_encrypted: encryptTokens(tokens),
      scopes: 'offline_access User.Read Mail.Send',
      status: 'connected',
      revoked_at: null,
      account_sub: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) return backTo(request, next, 'error');

  return backTo(request, next, 'connected');
}
