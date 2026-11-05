import { createHash, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { requireApiUser, safeInternalPath } from '@/lib/api/v1/http';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { GMAIL_CONNECT_REFUSAL, GMAIL_SEND_COOKIE, type GmailConnectRefusal } from '@/lib/constants/mailboxSend';
import { boundGoogleSubject, firmGoogleDomains } from '@/lib/email/firmGoogleDomains';
import { checkGrantIdentity, exchangeGmailCode, gmailSendConfigured, type GmailStoredTokens } from '@/lib/email/gmail';
import { encryptTokens } from '@/lib/email/tokenCrypto';
import { errorCodeOf } from '@/lib/errors/upstream';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * GET /api/v1/mailbox/google/callback — the return leg of Connect for sending
 * with Gmail (#490). The only writer of Google mailbox_connections rows.
 *
 *   1. The state must match the gmail_send_state cookie (timing-safe) and the
 *      gmail_send_verifier cookie must be present. The connect route (S3b)
 *      sets them. That does not make this route unreachable before S3b: a
 *      banker controls their own browser's cookies, so they can complete a
 *      round trip by hand. Such a round trip still passes every check below
 *      and can store only that banker's own approval, which is why the
 *      GOOGLE_SEND_* env stays unset in every environment until the connect
 *      route and the card ship (runbook, #490 audit 5).
 *   2. An external user (a counterparty or adviser) is refused not_eligible
 *      before the code is exchanged: sending from Gmail is for the bank's own
 *      people only (owner decision 2026-10-19). mailbox_sending_connect_google
 *      refuses them too.
 *   3. The firm's Workspace domains and the banker's bound Google sub are read
 *      before the code is exchanged, so a read error or a firm with no domain
 *      never mints a token.
 *   4. exchangeGmailCode checks the grant (gmail.send granted, nothing beyond
 *      the allowed scopes, a valid id_token with an hd claim);
 *      checkGrantIdentity checks the account (verified email equal to the
 *      banker's, the bound sub, an hd on a firm domain).
 *   5. mailbox_sending_connect_google stores the refresh token encrypted, with
 *      the granted scopes and the account sub, as a new connected row, and
 *      audits mailbox.connected ({provider} only) in the same transaction.
 *
 * Every outcome is a 307 back to where the banker started, with
 * ?mailbox=connected or ?mailbox=error&reason=<GmailConnectRefusal>, plus
 * &granted=1 when Google had already returned a code (so a grant exists at
 * Google), and the three cookies cleared. A refusal stores nothing and is
 * audited as mailbox.connect_refused ({provider, reason}); if that audit write
 * fails, the reason is not_recorded instead. A grant Google already issued
 * is never revoked from here: Google's revoke can end every grant the account
 * gave the Cloud project, Google sign-in included (#490 audit 1). The card
 * tells the banker to remove it at myaccount.google.com/permissions.
 */

const STATE_COOKIE = GMAIL_SEND_COOKIE.STATE;
const VERIFIER_COOKIE = GMAIL_SEND_COOKIE.VERIFIER;
const NEXT_COOKIE = GMAIL_SEND_COOKIE.NEXT;

function backTo(
  request: Request,
  next: string,
  outcome: 'connected' | GmailConnectRefusal,
  granted = false,
): NextResponse {
  const url = new URL(safeInternalPath(next), new URL(request.url).origin);
  if (outcome === 'connected') {
    url.searchParams.set('mailbox', 'connected');
  } else {
    url.searchParams.set('mailbox', 'error');
    url.searchParams.set('reason', outcome);
    // Google records the approval when the banker consents, before the code
    // reaches us, so any refusal after a code leaves a grant at Google. The
    // card then says where to remove it, whatever the reason.
    if (granted) url.searchParams.set('granted', '1');
  }
  const res = NextResponse.redirect(url);
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(VERIFIER_COOKIE);
  res.cookies.delete(NEXT_COOKIE);
  return res;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(rest.join('=')) || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Constant-time string equality: both sides are hashed first, so their lengths never leak or throw. */
function sameSecret(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export async function GET(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { admin, user } = auth;

  const next = cookieValue(request, NEXT_COOKIE) ?? '/';
  const callbackParams = new URL(request.url).searchParams;
  const granted = callbackParams.has('code') && !callbackParams.has('error');
  const refuse = async (reason: GmailConnectRefusal) => {
    const { error } = await admin.from('audit_log').insert({
      actor_id: user.id,
      action: AUDIT_ACTION.MAILBOX_CONNECT_REFUSED,
      detail: { provider: 'google', reason },
    });
    // Fail closed: a refusal with no audit row is reported as not recorded,
    // never as an ordinary refusal. Nothing was stored either way; only the
    // code is logged.
    if (error) {
      console.error('[gmail-connect] refusal audit write failed', { code: errorCodeOf(error) });
      return backTo(request, next, GMAIL_CONNECT_REFUSAL.NOT_RECORDED, granted);
    }
    return backTo(request, next, reason, granted);
  };

  if (!gmailSendConfigured()) return refuse(GMAIL_CONNECT_REFUSAL.FAILED);

  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  const expectedState = cookieValue(request, STATE_COOKIE);
  const verifier = cookieValue(request, VERIFIER_COOKIE);
  if (!state || !expectedState || !verifier || !sameSecret(state, expectedState)) {
    return refuse(GMAIL_CONNECT_REFUSAL.FAILED);
  }

  const providerError = params.get('error');
  if (providerError) {
    return refuse(providerError === 'access_denied' ? GMAIL_CONNECT_REFUSAL.CANCELLED : GMAIL_CONNECT_REFUSAL.FAILED);
  }
  const code = params.get('code');
  if (!code) return refuse(GMAIL_CONNECT_REFUSAL.FAILED);

  if (user.isExternal) return refuse(GMAIL_CONNECT_REFUSAL.NOT_ELIGIBLE);

  let firmDomains: string[];
  let boundSub: string | undefined;
  try {
    firmDomains = await firmGoogleDomains(admin, user.companyId);
    boundSub = await boundGoogleSubject(admin, user.id);
  } catch (err) {
    console.error('[gmail-connect] identity sources unreadable', { code: errorCodeOf(err) });
    return refuse(GMAIL_CONNECT_REFUSAL.FAILED);
  }
  if (firmDomains.length === 0) return refuse(GMAIL_CONNECT_REFUSAL.NO_FIRM_DOMAIN);

  const exchange = await exchangeGmailCode(code, verifier);
  if (!exchange.ok) return refuse(exchange.reason);
  const { grant } = exchange;

  const identityRefusal = checkGrantIdentity(grant, { email: user.email, firmDomains, boundSub });
  if (identityRefusal) return refuse(identityRefusal);

  let blob: string;
  try {
    blob = encryptTokens<GmailStoredTokens>({ refreshToken: grant.refreshToken });
  } catch {
    return refuse(GMAIL_CONNECT_REFUSAL.FAILED);
  }

  // One sending mailbox per user: the RPC deletes any earlier row, Microsoft or
  // Google, revoked or not, inserts a new one (a new id names this approval)
  // and audits mailbox.connected, all in one transaction (#490 audit 2).
  const { error: connectError } = await admin.rpc('mailbox_sending_connect_google', {
    p_user: user.id,
    p_email: grant.email,
    p_tokens_encrypted: blob,
    p_scopes: grant.scopes.join(' '),
    p_account_sub: grant.sub,
  });
  if (connectError) {
    console.error('[gmail-connect] storing the connection failed', { code: errorCodeOf(connectError) });
    return refuse(GMAIL_CONNECT_REFUSAL.FAILED);
  }

  return backTo(request, next, 'connected');
}
