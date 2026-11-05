import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { jsonError, requireApiUser, safeInternalPath } from '@/lib/api/v1/http';
import { flowCookieOptions } from '@/lib/auth/workIdentity';
import {
  GMAIL_CONNECT_REFUSAL,
  GMAIL_SEND_COOKIE,
  GMAIL_SEND_COOKIE_MAX_AGE_S,
} from '@/lib/constants/mailboxSend';
import { firmGoogleDomains } from '@/lib/email/firmGoogleDomains';
import { gmailSendAuthUrl, gmailSendConfigured, pkcePair } from '@/lib/email/gmail';
import { errorCodeOf } from '@/lib/errors/upstream';
import { requireFlag } from '@/lib/flags/requireFlag';

/**
 * GET /api/v1/mailbox/google/connect: start Connect for sending with Gmail
 * (#490). A browser entry point: 307 to Google's consent screen for openid,
 * email and gmail.send, with PKCE (S256), access_type=offline,
 * prompt=consent, login_hint = the caller's own address and hd = the firm's
 * Google Workspace domain (a hint only: the callback enforces the hd claim).
 *
 * The state, the PKCE verifier and the return path ride in short-lived
 * httpOnly cookies (gmail_send_*; SameSite=Lax, Secure outside development,
 * 600 s) that only this route sets and only the callback reads (R28).
 *
 *   503 the sending client is not configured on this deployment.
 *   403 the caller is an external user (reason not_eligible): sending from
 *       Gmail is for the bank's own people only (owner decision 2026-10-19),
 *       so an external never reaches Google's consent screen.
 *   409 the firm has no Google Workspace domain on record (reason
 *       no_firm_domain): there is nothing to check the account against, so no
 *       consent is started.
 *   500 the firm's domains could not be read.
 */
export async function GET(request: Request) {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { admin, user } = auth;

  if (!gmailSendConfigured()) {
    return jsonError('Gmail sending not configured (Google sending client env missing)', 503);
  }

  if (user.isExternal) {
    return NextResponse.json(
      { error: "Sending from Gmail is for the bank's own team", reason: GMAIL_CONNECT_REFUSAL.NOT_ELIGIBLE },
      { status: 403 },
    );
  }

  let firmDomains: string[];
  try {
    firmDomains = await firmGoogleDomains(admin, user.companyId);
  } catch (err) {
    console.error('[gmail-connect] firm domains unreadable', { code: errorCodeOf(err) });
    return jsonError('Firm Google Workspace domain unavailable', 500);
  }
  if (firmDomains.length === 0) {
    return NextResponse.json(
      {
        error: "Your firm's Google Workspace is not set up for sending yet",
        reason: GMAIL_CONNECT_REFUSAL.NO_FIRM_DOMAIN,
      },
      { status: 409 },
    );
  }

  const next = safeInternalPath(new URL(request.url).searchParams.get('next'));
  const { verifier, challenge } = pkcePair();
  const state = randomUUID();

  const res = NextResponse.redirect(
    gmailSendAuthUrl({ state, challenge, loginHint: user.email, hd: firmDomains[0] }),
  );
  const cookie = flowCookieOptions(GMAIL_SEND_COOKIE_MAX_AGE_S);
  res.cookies.set(GMAIL_SEND_COOKIE.STATE, state, cookie);
  res.cookies.set(GMAIL_SEND_COOKIE.VERIFIER, verifier, cookie);
  res.cookies.set(GMAIL_SEND_COOKIE.NEXT, next, cookie);
  return res;
}
