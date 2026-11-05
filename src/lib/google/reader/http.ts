// The HTTP client every Google request goes through (#259, design R6). It
// sends a bearer token only to the origins in GOOGLE_ALLOWED_ORIGINS, retries
// throttling with Retry-After or full-jitter backoff, refreshes the token once
// on a 401, and never puts a response body in a thrown error: a body can quote
// mail. It mirrors the Graph client's loop without importing it, so the two
// providers stay uncoupled.

import { GOOGLE_ALLOWED_ORIGINS } from '@/lib/constants/googleReader';
import { codeShaped } from '@/lib/errors/upstream';

export type GetGoogleToken = (options?: { forceRefresh?: boolean }) => Promise<string>;
export type GoogleHttpOptions = {
  getToken: GetGoogleToken;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Per attempt, the response body included; a timeout rejects with TimeoutError and is not retried here. */
  timeoutMs?: number;
};
// 60 s leaves room for a 25 MiB raw message at about 3.5 Mbit/s (thread T2); a timeout costs one pg-boss retry.
export const GOOGLE_HTTP_DEFAULTS = { maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 64_000, timeoutMs: 60_000 } as const;

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** A Google request that did not succeed. Carries the status and Google's
 * machine reason only (error.errors[0].reason or error.status), never a
 * message or body: a body can quote mail. */
export class GoogleHttpError extends Error {
  readonly status: number;
  readonly reason: string | null;
  readonly throttled: boolean;
  constructor(status: number, reason: string | null, attempts: number) {
    super(
      `Google request failed: ${status}${reason ? ` ${reason}` : ''} after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
    );
    this.name = 'GoogleHttpError';
    this.status = status;
    this.reason = reason;
    this.throttled = status === 429 || (status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason));
  }
}

/** Returns the URL when its origin may receive a Google token, and throws before any request otherwise. */
export function googleUrl(url: string): string {
  const parsed = new URL(url);
  if (!(GOOGLE_ALLOWED_ORIGINS as readonly string[]).includes(parsed.origin)) {
    throw new Error(`Refusing to send a Google token to ${parsed.origin}`);
  }
  return parsed.toString();
}

/** The request's own deadline ended it (AbortSignal.timeout), not the response: matched by name only. */
export function isDeadlineError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Reduces an error response to Google's machine reason. Never returns a message:
 * a reason that is not code-shaped is dropped (#331). A body that is not JSON
 * gives no reason; a body that outlives the attempt's deadline rethrows, so a
 * stalled error response is a timeout, never an HTTP failure. */
async function reasonOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as {
      error?: { status?: string; errors?: Array<{ reason?: string }> } | string;
    };
    // The OAuth token endpoint answers { error: 'unauthorized_client' }.
    if (typeof body.error === 'string') return codeShaped(body.error);
    return codeShaped(body.error?.errors?.[0]?.reason ?? body.error?.status ?? null);
  } catch (error) {
    if (isDeadlineError(error)) throw error;
    return null;
  }
}

function retryAfterMs(res: Response, now: () => number = Date.now): number | null {
  const header = res.headers.get('Retry-After');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now());
}

function backoffMs(attempt: number, base: number, max: number, random: () => number): number {
  return Math.floor(random() * Math.min(max, base * 2 ** (attempt - 1)));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(status: number, reason: string | null): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason);
}

/** One Google request with the bearer set last (a caller cannot override it),
 * one forced token refresh on a 401, and retries for 429, 5xx and 403
 * rateLimitExceeded / userRateLimitExceeded. */
export async function googleFetch(url: string, init: RequestInit, options: GoogleHttpOptions): Promise<Response> {
  const target = googleUrl(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? GOOGLE_HTTP_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? GOOGLE_HTTP_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? GOOGLE_HTTP_DEFAULTS.maxDelayMs;
  const timeoutMs = options.timeoutMs ?? GOOGLE_HTTP_DEFAULTS.timeoutMs;

  let forceRefresh = false;
  let refreshed = false;
  for (let attempt = 1; ; attempt += 1) {
    const token = await options.getToken(forceRefresh ? { forceRefresh: true } : undefined);
    forceRefresh = false;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    // The signal stays bound to the response body, so the caller's json() / arrayBuffer() shares the attempt's budget.
    const res = await fetchImpl(target, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return res;

    if (res.status === 401 && !refreshed && attempt < maxAttempts) {
      refreshed = true;
      forceRefresh = true;
      continue;
    }

    const reason = await reasonOf(res);
    if (!isRetryable(res.status, reason) || attempt >= maxAttempts) {
      throw new GoogleHttpError(res.status, reason, attempt);
    }
    const wait = retryAfterMs(res) ?? backoffMs(attempt, baseDelayMs, maxDelayMs, random);
    await sleep(Math.min(wait, maxDelayMs));
  }
}

export async function googleJson<T>(url: string, options: GoogleHttpOptions, init: RequestInit = {}): Promise<T> {
  const res = await googleFetch(url, init, options);
  return (await res.json()) as T;
}
