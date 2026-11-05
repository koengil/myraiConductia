// The keyless token chain (#259, design R5 and R14): the worker's own identity
// (see credentials.ts) asks IAM Credentials to sign a domain-wide-delegation
// JWT as the DWD service account, and Google's token endpoint exchanges it for
// a mailbox-scoped access token. No key is ever held here.

import type { GmailReaderScope } from '@/lib/constants/googleReader';
import { codeShaped } from '@/lib/errors/upstream';

import type { CallerTokenSource } from './credentials';
import { googleJson, googleUrl, isDeadlineError, type GetGoogleToken, type GoogleHttpOptions } from './http';

export type GoogleSigningIdentity = { tenantId: string; serviceAccountEmail: string };
export type DelegationOutcome = 'ok' | 'missing' | 'error';

/** An OAuth token endpoint refusal, reduced to its error code. unauthorized_client
 * means the DWD client is not authorised for this scope in the user's domain. */
export class GoogleTokenError extends Error {
  constructor(
    readonly reason: string | null,
    readonly status: number,
  ) {
    super(`Google token exchange failed: ${status}${reason ? ` ${reason}` : ''}`);
    this.name = 'GoogleTokenError';
  }
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LIFETIME_S = 3_600; // Google APIs cap at 1 h
const REFRESH_MARGIN_MS = 5 * 60_000;

export type DelegatedTokenDeps = {
  callerToken: CallerTokenSource;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The reader records delegation status on change (plan D11). */
  onOutcome?: (identity: GoogleSigningIdentity, outcome: DelegationOutcome) => void;
  /** The token exchange's deadline, body included. A timeout says nothing about the grant, so it records no outcome. */
  timeoutMs?: number;
};
export const GOOGLE_TOKEN_TIMEOUT_MS = 15_000;

/** Builds one token source per (registration, address, scope). The cache key
 * includes the scope, so a narrower source can never reuse a wider token (R13). */
export function createDelegatedTokenCache(deps: DelegatedTokenDeps) {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const now = deps.now ?? Date.now;
  // signJwt goes through googleFetch with its 60 s per-attempt default (design 03: googleFetch 60 s, the DWD token
  // exchange 15 s); the caller token it waits on is bounded separately (credentials.ts, 15 s).
  const callerHttp: GoogleHttpOptions = { getToken: deps.callerToken, fetchImpl: deps.fetchImpl };

  async function mint(identity: GoogleSigningIdentity, subject: string, scope: GmailReaderScope | string) {
    const iat = Math.floor(now() / 1000);
    const payload = JSON.stringify({
      iss: identity.serviceAccountEmail,
      sub: subject,
      scope,
      aud: TOKEN_URL,
      iat,
      exp: iat + LIFETIME_S,
    });
    const signUrl = googleUrl(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(identity.serviceAccountEmail)}:signJwt`,
    );
    // A refused signJwt (the caller may not sign as the DWD account, or Google is down)
    // is a failed mint too: the health view shows it as a failed delegation check.
    const { signedJwt } = await googleJson<{ signedJwt: string }>(signUrl, callerHttp, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    }).catch((error: unknown) => {
      // A stalled signJwt says nothing about the grant (r11).
      if (!isDeadlineError(error)) deps.onOutcome?.(identity, 'error');
      throw error;
    });
    const res = await (deps.fetchImpl ?? fetch)(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedJwt }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? GOOGLE_TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Only a code-shaped error is kept: anything else could quote content into the message (#331). A body that is
      // not JSON gives no reason; one that outlives the deadline rethrows before any outcome (a stall says nothing
      // about the grant).
      const body = await res.json().catch((error: unknown) => {
        if (isDeadlineError(error)) throw error;
        return {};
      });
      const reason = codeShaped((body as { error?: unknown }).error);
      deps.onOutcome?.(identity, reason === 'unauthorized_client' ? 'missing' : 'error');
      throw new GoogleTokenError(reason, res.status);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    deps.onOutcome?.(identity, 'ok');
    return { token: body.access_token, expiresAt: now() + body.expires_in * 1000 };
  }

  return {
    forSubject(identity: GoogleSigningIdentity, subject: string, scope: GmailReaderScope | string): GetGoogleToken {
      const key = `${identity.tenantId}|${identity.serviceAccountEmail}|${subject.toLowerCase()}|${scope}`;
      return async (options) => {
        const hit = cache.get(key);
        if (!options?.forceRefresh && hit && hit.expiresAt - REFRESH_MARGIN_MS > now()) return hit.token;
        const fresh = await mint(identity, subject.toLowerCase(), scope);
        cache.set(key, fresh);
        return fresh.token;
      };
    },
  };
}

/** A token for a service account's own identity (the directory SA): no DWD, no sub. */
export async function serviceAccountAccessToken(
  callerToken: CallerTokenSource,
  serviceAccountEmail: string,
  scopes: string[],
  fetchImpl?: typeof fetch,
): Promise<string> {
  const url = googleUrl(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:generateAccessToken`,
  );
  const { accessToken } = await googleJson<{ accessToken: string }>(
    url,
    { getToken: callerToken, fetchImpl },
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: scopes, lifetime: '3600s' }),
    },
  );
  return accessToken;
}
