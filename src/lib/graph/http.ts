// The low-level Microsoft Graph HTTP client shared by the discovery reader
// (ADR-005). The delegated send flow (src/lib/email/graph.ts) is unchanged and
// does not use it yet.
//
//   graphFetch   one request, with the bearer token, throttling and retries
//   graphJson    graphFetch + JSON body
//   graphPages   follows @odata.nextLink, yielding each page with the link
//                that resumes after it, so a caller can checkpoint per page
//   graphDownload  file content: follows the pre-authenticated redirect
//                without the bearer token, and caps the bytes read
//
// Retries: 429 and 5xx (and network failures) are retried, waiting for
// Retry-After when Graph sends one (seconds or an HTTP date), else a capped
// exponential backoff with full jitter. A 401 refreshes the token once. When
// the attempts run out the error is thrown, the job fails, and the queue
// retries it later from the last checkpoint.
//
// Deadline: each attempt, its body included, and the download redirect get
// timeoutMs (#409 F4, as Google's client since #412). A timeout rejects with
// TimeoutError and is not retried here: it costs one queue retry.
//
// Only https://graph.microsoft.com is ever sent a token: a nextLink or
// deltaLink pointing anywhere else is refused.

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GRAPH_ORIGIN = 'https://graph.microsoft.com';

export type GetGraphToken = (options?: { forceRefresh?: boolean }) => Promise<string>;

export type GraphHttpOptions = {
  getToken: GetGraphToken;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Total attempts per request, the first included. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Extra headers on every request (for example Prefer). */
  headers?: Record<string, string>;
  /** Per attempt, the response body included; a timeout rejects with TimeoutError and is not retried here. */
  timeoutMs?: number;
};

export const GRAPH_HTTP_DEFAULTS = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  // 60 s leaves room for a 25 MiB download (EXTRACT_MAX_BYTES) at about 3.5 Mbit/s, the same budget as Google's.
  timeoutMs: 60_000,
} as const;

/**
 * A Graph request that did not succeed. Carries the status, Graph's error
 * code and request id, never a response body: a body can quote mail.
 */
export class GraphHttpError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly throttled: boolean;

  constructor(status: number, code: string | null, requestId: string | null, attempts: number) {
    const throttled = status === 429 || status === 503;
    super(
      `Graph request failed: ${status}${code ? ` ${code}` : ''}` +
        (attempts > 1 ? ` after ${attempts} attempts` : '') +
        (requestId ? ` (request-id ${requestId})` : ''),
    );
    this.name = 'GraphHttpError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.throttled = throttled;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Null if absent or unreadable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

export function backoffMs(attempt: number, options: { baseDelayMs: number; maxDelayMs: number; random: () => number }): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.floor(options.random() * ceiling);
}

/** Absolute Graph URL for a path or a link Graph returned; refuses any other host. */
export function graphUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('/')) return `${GRAPH_BASE_URL}${pathOrUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(pathOrUrl);
  } catch {
    throw new Error('Refusing a Graph link that is not a URL');
  }
  if (parsed.origin !== GRAPH_ORIGIN) {
    throw new Error(`Refusing to send a Graph token to ${parsed.origin}`);
  }
  return parsed.toString();
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A Graph error code is a short token (ErrorItemNotFound, TooManyRequests) and a request id is a
// GUID. Anything else is not one, and the body or a header a proxy rewrote can quote mail, so a
// value of another shape is dropped here and never reaches GraphHttpError's message (#331).
const GRAPH_CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;
const GRAPH_REQUEST_ID_SHAPE = /^[0-9A-Fa-f-]{8,64}$/;

/** The request's own deadline ended it (AbortSignal.timeout), not the response: matched by name only. */
export function isDeadlineError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** A body that outlives the attempt's deadline rethrows, so a stalled error response is a timeout, never an HTTP failure. */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' && GRAPH_CODE_SHAPE.test(code) ? code : null;
  } catch (error) {
    if (isDeadlineError(error)) throw error;
    return null;
  }
}

function requestIdOf(res: Response): string | null {
  const id = res.headers.get('request-id');
  return id !== null && GRAPH_REQUEST_ID_SHAPE.test(id) ? id : null;
}

export async function graphFetch(
  pathOrUrl: string,
  init: RequestInit & { redirect?: RequestRedirect } = {},
  options: GraphHttpOptions,
): Promise<Response> {
  const url = graphUrl(pathOrUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? GRAPH_HTTP_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? GRAPH_HTTP_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? GRAPH_HTTP_DEFAULTS.maxDelayMs;
  const timeoutMs = options.timeoutMs ?? GRAPH_HTTP_DEFAULTS.timeoutMs;

  let refreshed = false;
  let forceRefresh = false;
  for (let attempt = 1; ; attempt += 1) {
    const token = await options.getToken({ forceRefresh });
    forceRefresh = false;
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (!headers.has(name)) headers.set(name, value);
    }
    headers.set('Authorization', `Bearer ${token}`);

    let res: Response;
    try {
      // The signal stays bound to the response body, so the caller's json() or body read shares the attempt's budget.
      // A caller's own signal still cancels; either abort ends the request without a retry.
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
      res = await fetchImpl(url, { ...init, headers, signal });
    } catch (error) {
      if (isDeadlineError(error) || attempt >= maxAttempts) throw error;
      await sleep(backoffMs(attempt, { baseDelayMs, maxDelayMs, random }));
      continue;
    }

    if (res.ok || (res.status >= 300 && res.status < 400)) return res;

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      forceRefresh = true;
      await res.body?.cancel().catch(() => undefined);
      continue;
    }

    if (isRetryableStatus(res.status) && attempt < maxAttempts) {
      const wait = retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt, { baseDelayMs, maxDelayMs, random });
      await res.body?.cancel().catch(() => undefined);
      await sleep(Math.min(wait, maxDelayMs * 5));
      continue;
    }

    throw new GraphHttpError(res.status, await errorCode(res), requestIdOf(res), attempt);
  }
}

export async function graphJson<T>(pathOrUrl: string, options: GraphHttpOptions, init: RequestInit = {}): Promise<T> {
  const res = await graphFetch(pathOrUrl, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }, options);
  return (await res.json()) as T;
}

export type GraphPage<T> = {
  value: T[];
  /** The link that resumes after this page: the next page's, or the delta link at the end. */
  nextLink: string | null;
  deltaLink: string | null;
};

type ODataPage<T> = {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
};

/** Every page of a collection or delta query, in order, each with the link that resumes after it. */
export async function* graphPages<T>(pathOrUrl: string, options: GraphHttpOptions): AsyncGenerator<GraphPage<T>> {
  let next: string | null = pathOrUrl;
  while (next) {
    const body: ODataPage<T> = await graphJson<ODataPage<T>>(next, options);
    const nextLink = body['@odata.nextLink'] ?? null;
    const deltaLink = body['@odata.deltaLink'] ?? null;
    yield { value: body.value ?? [], nextLink, deltaLink };
    next = nextLink;
  }
}

/** Thrown when a download exceeds its byte cap. */
export class GraphDownloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Graph download exceeds ${maxBytes} bytes`);
    this.name = 'GraphDownloadTooLargeError';
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new GraphDownloadTooLargeError(maxBytes);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GraphDownloadTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A driveItem's content. Graph answers 302 to a short-lived pre-authenticated
 * URL; that URL is fetched without the bearer token, over https only.
 */
export async function graphDownload(pathOrUrl: string, options: GraphHttpOptions & { maxBytes: number }): Promise<Uint8Array> {
  const res = await graphFetch(pathOrUrl, { redirect: 'manual' }, options);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => undefined);
    if (!location || !location.startsWith('https://')) {
      throw new Error('Graph download redirect is not an https URL');
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? GRAPH_HTTP_DEFAULTS.timeoutMs;
    const file = await fetchImpl(location, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    if (!file.ok) throw new GraphHttpError(file.status, null, null, 1);
    return readCapped(file, options.maxBytes);
  }
  return readCapped(res, options.maxBytes);
}
