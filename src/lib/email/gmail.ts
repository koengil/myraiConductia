import { createHash, randomBytes } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  GMAIL_CONNECT_REFUSAL,
  GMAIL_SEND_ALLOWED_GRANTED_SCOPES,
  GMAIL_SEND_REQUESTED_SCOPES,
  GMAIL_SEND_SCOPE,
  gmailMisconfiguredError,
  gmailReconnectError,
} from '@/lib/constants/mailboxSend';
import {
  OperatorCopyError,
  UpstreamHttpError,
  codeShaped,
  dbFailure,
  errorCodeFromBody,
  errorCodeOf,
  upstreamErrorCode,
} from '@/lib/errors/upstream';
import { buildRfc822 } from './rfc822';
import { decryptTokens } from './tokenCrypto';
import type { EmailSendReceipt, MessageInput } from './transport';

/**
 * Gmail send as the banker (#490): the sending client's OAuth web flow, the
 * grant checks, the per-send token refresh and users.messages.send.
 *
 * This is a separate OAuth client from the DWD reader (src/lib/google/reader)
 * and from Google sign-in. It uses plain fetch and imports nothing from
 * src/lib/google or the Google SDKs (R2; tests/google/no-send-path.test.ts),
 * and it names only openid, email and gmail.send
 * (tests/email/gmail-scopes.test.ts).
 *
 * Configuration (all server-side env, R1):
 *   GOOGLE_SEND_CLIENT_ID / GOOGLE_SEND_CLIENT_SECRET  the sending web client.
 *   GOOGLE_SEND_REDIRECT_URI                           .../api/v1/mailbox/google/callback.
 *   MAILBOX_TOKEN_KEY                                  the token-at-rest key (./tokenCrypto).
 *
 * Errors carry a status and a code-shaped token, never a response body: a
 * Google error body can quote the message, an address or the account.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** The id_token issuers Google documents (OIDC Core 3.1.3.7 step 2). */
const GOOGLE_ISSUERS: ReadonlySet<string> = new Set(['https://accounts.google.com', 'accounts.google.com']);

/** The token endpoint's deadline, body included. */
export const GMAIL_TOKEN_TIMEOUT_MS = 15_000;
/** messages.send's deadline. A timeout is an ambiguous outcome (the mail may have gone), so it is never retried. */
export const GMAIL_SEND_TIMEOUT_MS = 30_000;

/** The scope string the authorize URL requests: exactly openid, email and gmail.send (design Q2). */
export const GMAIL_SEND_SCOPES = GMAIL_SEND_REQUESTED_SCOPES.join(' ');

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' } as const;

export function gmailSendConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_SEND_CLIENT_ID &&
      process.env.GOOGLE_SEND_CLIENT_SECRET &&
      process.env.GOOGLE_SEND_REDIRECT_URI &&
      process.env.MAILBOX_TOKEN_KEY,
  );
}

/** A PKCE pair: an 86-character base64url verifier (64 random bytes) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Google's authorize URL for the sending client. `prompt=consent` every time,
 * so Google always returns a refresh token, including on a reconnect after a
 * Block (R3). `hd` and `login_hint` are hints to Google's account chooser
 * only; the callback enforces the account (checkGrantIdentity). No
 * include_granted_scopes: an earlier grant must not widen this one.
 */
export function gmailSendAuthUrl(o: { state: string; challenge: string; loginHint: string; hd: string }): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_SEND_CLIENT_ID ?? '',
    redirect_uri: process.env.GOOGLE_SEND_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: GMAIL_SEND_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: o.state,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
  });
  if (o.loginHint) params.set('login_hint', o.loginHint);
  if (o.hd) params.set('hd', o.hd);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GmailGrant = {
  refreshToken: string;
  email: string;
  emailVerified: boolean;
  sub: string;
  hd: string | null;
  /** The scopes Google actually granted, normalized (split, deduplicated, sorted). This is what gets stored. */
  scopes: string[];
};

/** Token-level refusals only. Who the account belongs to is checkGrantIdentity's (R27). not_workspace here = no hd claim. */
export type ExchangeRefusal = 'scope_missing' | 'scope_unexpected' | 'not_workspace' | 'failed';

export type GmailExchange =
  | { ok: true; grant: GmailGrant }
  /**
   * Nothing to revoke: Conductia never revokes a refused grant, because
   * Google's revoke can end the account's other grants in the same Cloud
   * project, Google sign-in included (#490 audit 1). The banker removes it at
   * myaccount.google.com/permissions.
   */
  | { ok: false; reason: ExchangeRefusal };

/** A token response's `scope` as a sorted, deduplicated list. */
export function normalizeScopes(scope: unknown): string[] {
  if (typeof scope !== 'string') return [];
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

type IdTokenClaims = { sub: string; email: string; emailVerified: boolean; hd: string | null };

/**
 * The id_token's claims, when its aud, iss and exp check out. The signature is
 * not verified: the token came straight from Google's token endpoint over TLS
 * in the code exchange (OIDC Core 3.1.3.7 step 6). Null for anything else.
 */
function idTokenClaims(idToken: unknown): IdTokenClaims | null {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const { aud, iss, exp, sub, email, email_verified: emailVerified, hd } = payload;
  const clientId = process.env.GOOGLE_SEND_CLIENT_ID ?? '';
  if (!clientId || aud !== clientId) return null;
  if (typeof iss !== 'string' || !GOOGLE_ISSUERS.has(iss)) return null;
  if (typeof exp !== 'number' || exp * 1000 <= Date.now()) return null;
  if (typeof sub !== 'string' || !sub) return null;
  if (typeof email !== 'string' || !email) return null;
  return {
    sub,
    email,
    // Google sends a boolean; older tokens carried the string "true".
    emailVerified: emailVerified === true || emailVerified === 'true',
    hd: typeof hd === 'string' && hd ? hd : null,
  };
}

/** POST to the token endpoint. Null when no response came back (network error or timeout). */
async function tokenPost(body: URLSearchParams): Promise<Response | null> {
  try {
    return await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: FORM,
      body: body.toString(),
      signal: AbortSignal.timeout(GMAIL_TOKEN_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** A JSON object body, or null when the body is not one (or could not be read). */
async function jsonObject(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function refusal(reason: ExchangeRefusal): GmailExchange {
  return { ok: false, reason };
}

/**
 * Exchanges the callback's code (with the PKCE verifier and the client
 * secret) and checks the grant: gmail.send granted, nothing beyond the allowed
 * set (Google may report `email` as userinfo.email), a valid id_token, and an
 * hd claim. A refusal carries only its reason; the token is dropped.
 */
export async function exchangeGmailCode(code: string, verifier: string): Promise<GmailExchange> {
  const res = await tokenPost(
    new URLSearchParams({
      client_id: process.env.GOOGLE_SEND_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_SEND_CLIENT_SECRET ?? '',
      redirect_uri: process.env.GOOGLE_SEND_REDIRECT_URI ?? '',
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
    }),
  );
  if (!res || !res.ok) return refusal(GMAIL_CONNECT_REFUSAL.FAILED);
  const data = await jsonObject(res);
  const rawRefreshToken = data?.refresh_token;
  const refreshToken = typeof rawRefreshToken === 'string' && rawRefreshToken ? rawRefreshToken : null;
  if (!data || !refreshToken) return refusal(GMAIL_CONNECT_REFUSAL.FAILED);

  const claims = idTokenClaims(data.id_token);
  const scopes = normalizeScopes(data.scope);
  if (!scopes.includes(GMAIL_SEND_SCOPE)) return refusal(GMAIL_CONNECT_REFUSAL.SCOPE_MISSING);
  if (scopes.some((s) => !GMAIL_SEND_ALLOWED_GRANTED_SCOPES.has(s))) return refusal(GMAIL_CONNECT_REFUSAL.SCOPE_UNEXPECTED);
  if (!claims) return refusal(GMAIL_CONNECT_REFUSAL.FAILED);
  // No hd claim means a consumer Google account, never a Workspace one.
  if (!claims.hd) return refusal(GMAIL_CONNECT_REFUSAL.NOT_WORKSPACE);

  return {
    ok: true,
    grant: {
      refreshToken,
      email: claims.email,
      emailVerified: claims.emailVerified,
      sub: claims.sub,
      hd: claims.hd,
      scopes,
    },
  };
}

export type IdentityRefusal = 'wrong_account' | 'not_workspace';

const lower = (value: string) => value.trim().toLowerCase();

/**
 * Whether the granted Google account may send as this banker (design Q2,
 * R19): a verified email equal to the banker's Conductia address, the same
 * sub as their bound Google identity when they have one, and an hd claim on
 * one of the firm's Google Workspace domains. Null when it may.
 */
export function checkGrantIdentity(
  g: GmailGrant,
  who: { email: string; firmDomains: string[]; boundSub?: string },
): IdentityRefusal | null {
  if (!g.emailVerified) return GMAIL_CONNECT_REFUSAL.WRONG_ACCOUNT;
  if (lower(g.email) !== lower(who.email)) return GMAIL_CONNECT_REFUSAL.WRONG_ACCOUNT;
  if (who.boundSub && g.sub !== who.boundSub) return GMAIL_CONNECT_REFUSAL.WRONG_ACCOUNT;
  const hd = g.hd ? lower(g.hd) : '';
  if (!hd || !who.firmDomains.some((domain) => lower(domain) === hd)) return GMAIL_CONNECT_REFUSAL.NOT_WORKSPACE;
  return null;
}

/**
 * revoked: any HTTP 400 invalid_grant, whatever its error_subtype (the banker
 * removed the app, the admin Blocked it, the token expired: R6).
 * misconfigured: Google refused Conductia's own client; no banker is disconnected.
 * upstream: anything else; status 0 means no response (network error or timeout).
 */
export type GmailRefresh =
  | { ok: true; accessToken: string }
  | { ok: false; kind: 'revoked' | 'misconfigured' | 'upstream'; status: number };

/** Mints a fresh access token for one send (R5). Never throws. */
export async function refreshGmailAccessToken(refreshToken: string): Promise<GmailRefresh> {
  const res = await tokenPost(
    new URLSearchParams({
      client_id: process.env.GOOGLE_SEND_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_SEND_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  );
  if (!res) return { ok: false, kind: 'upstream', status: 0 };
  if (res.ok) {
    const data = await jsonObject(res);
    const accessToken = data?.access_token;
    return typeof accessToken === 'string' && accessToken
      ? { ok: true, accessToken }
      : { ok: false, kind: 'upstream', status: res.status };
  }
  const code = await upstreamErrorCode(res);
  if (res.status === 400 && code === 'invalid_grant') return { ok: false, kind: 'revoked', status: res.status };
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return { ok: false, kind: 'misconfigured', status: res.status };
  }
  return { ok: false, kind: 'upstream', status: res.status };
}

/** Gmail's error reason (`error.errors[0].reason`, else `error.status`), code-shaped, never the message. */
async function gmailErrorCode(res: Response): Promise<string | null> {
  const body = await jsonObject(res);
  const rawError = body?.error;
  const error = rawError && typeof rawError === 'object' ? (rawError as Record<string, unknown>) : null;
  const errors = error?.errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : null;
  const reason = first && typeof first === 'object' ? (first as Record<string, unknown>).reason : null;
  return codeShaped(reason) ?? codeShaped(error?.status) ?? errorCodeFromBody(body);
}

/**
 * users.messages.send with a base64url RFC 822 message (the JSON `{raw}` path;
 * the outbox caps sit far below Gmail's limit, R8). Never retried: a failure
 * may still have sent the mail. Throws UpstreamHttpError('gmail-send', ...)
 * with status 0 when no response came back.
 */
export async function gmailSendRaw(accessToken: string, raw: string): Promise<{ id: string; threadId: string }> {
  let res: Response;
  try {
    res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(GMAIL_SEND_TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamHttpError('gmail-send', 'messages.send', 0);
  }
  if (!res.ok) throw new UpstreamHttpError('gmail-send', 'messages.send', res.status, await gmailErrorCode(res));
  const data = await jsonObject(res);
  const id = data?.id;
  const threadId = data?.threadId;
  if (typeof id !== 'string' || !id) throw new UpstreamHttpError('gmail-send', 'messages.send', res.status, 'no_message_id');
  return { id, threadId: typeof threadId === 'string' ? threadId : '' };
}

/** What a Google connection stores, encrypted: the refresh token only. A fresh access token is minted per send (R5). */
export type GmailStoredTokens = { refreshToken: string };

/** What sendViaGmail reads from a Google mailbox_connections row (the dispatcher has checked provider and status). */
export type GmailConnectionRow = { id: string; user_id: string; email: string; tokens_encrypted: string | null };

/**
 * Ends a Google connection's approval after an invalid_grant (R6): the row
 * turns revoked and its dead token is deleted, conditional on the token blob
 * this send read, so a slow failing send never wipes a reconnect that landed
 * while it was in flight. One RPC writes the change and its
 * mailbox.approval_ended audit row ({provider} only) in one transaction
 * (#490 audit 2), so neither lands without the other. Never throws: the send
 * fails with the reconnect copy either way. True when the row was marked.
 */
export async function markRevoked(admin: SupabaseClient, rowId: string, readBlob: string): Promise<boolean> {
  const { data, error } = await admin.rpc('mailbox_sending_mark_revoked', {
    p_connection: rowId,
    p_read_blob: readBlob,
  });
  if (error) {
    console.error('[gmail-send] marking the connection revoked failed', { code: errorCodeOf(error) });
    return false;
  }
  return data === true;
}

/** The banker's display name for the From (users.display_name ?? full_name). A read error fails the send. */
async function senderName(admin: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await admin.from('users').select('display_name, full_name').eq('id', userId).maybeSingle();
  if (error) throw dbFailure('Sender name read', error);
  const user = data as { display_name?: string | null; full_name?: string | null } | null;
  return user?.display_name || user?.full_name || null;
}

/**
 * Sends one message through a connected Google row: refresh, build with From
 * pinned to the row's address (./rfc822), messages.send. The dispatcher
 * (./connectedSender) has already refused a revoked row and a missing config.
 *   invalid_grant          markRevoked, then the reconnect copy
 *   invalid_client, ...    operator copy; the row is untouched
 *   anything else          UpstreamHttpError('gmail-token', ...); the row is untouched
 * The receipt is Gmail's real message id.
 */
export async function sendViaGmail(
  admin: SupabaseClient,
  row: GmailConnectionRow,
  message: MessageInput,
): Promise<EmailSendReceipt> {
  const blob = row.tokens_encrypted;
  const stored = blob ? decryptTokens<GmailStoredTokens>(blob) : null;
  // A wrong MAILBOX_TOKEN_KEY or a damaged blob: not an ended approval, so the row is left alone.
  if (!blob || !stored?.refreshToken) {
    throw new OperatorCopyError('Gmail connection unreadable; connect for sending again in Settings › Mail');
  }

  const refresh = await refreshGmailAccessToken(stored.refreshToken);
  if (!refresh.ok) {
    if (refresh.kind === 'revoked') {
      await markRevoked(admin, row.id, blob);
      throw gmailReconnectError();
    }
    if (refresh.kind === 'misconfigured') throw gmailMisconfiguredError();
    throw new UpstreamHttpError('gmail-token', 'refresh', refresh.status);
  }

  const raw = await buildRfc822(message, { address: row.email, name: await senderName(admin, row.user_id) });
  const sent = await gmailSendRaw(refresh.accessToken, raw);
  return { id: sent.id, provider: 'gmail' };
}
