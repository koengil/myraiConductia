/**
 * The browser's call into the platform REST API (`/api/v1/*`). Feature UI uses
 * this instead of a raw `fetch` so a failed status can never pass as success:
 * any non-2xx response throws an `ApiV1Error`, which a caller handles like a
 * network failure. A 401 means the session ended, so the browser goes to
 * sign-in and comes back to the same page.
 *
 * Client-safe: no server-only import. The server helpers live in
 * `src/lib/api/v1/` (`http.ts`, `access.ts`).
 */

export type ApiV1Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export class ApiV1Error extends Error {
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** The handler's `{ error }` text, when it sent one. */
  readonly serverMessage: string | null;

  constructor(status: number, serverMessage: string | null) {
    super(serverMessage ?? (status === 0 ? 'Network error' : `Request failed with ${status}`));
    this.name = 'ApiV1Error';
    this.status = status;
    this.serverMessage = serverMessage;
  }

  /**
   * Text fit to show the user: a 4xx handler message is written for them (for
   * example "Only the deal MD can move the rail backwards"); a 5xx message can
   * be a raw database error, so it is never shown.
   */
  get userMessage(): string | null {
    return this.status >= 400 && this.status < 500 ? this.serverMessage : null;
  }
}

export type ApiV1Options = {
  signal?: AbortSignal;
  /** Called on a 401 instead of the sign-in redirect (tests, embedded flows). */
  onUnauthorized?: () => void;
};

function signInAgain() {
  const here = `${window.location.pathname}${window.location.search}`;
  // A full navigation: the ended session's client state must not survive.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/sign-in?redirectTo=${encodeURIComponent(here)}`);
}

async function errorText(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * `path` is relative to `/api/v1`, starting with `/`. A JSON `body` is sent with
 * its content type. Resolves with the parsed JSON body (undefined for 204).
 */
export async function apiV1<T = unknown>(
  method: ApiV1Method,
  path: string,
  body?: unknown,
  options: ApiV1Options = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiV1Error(0, null);
  }

  if (!res.ok) {
    if (res.status === 401) (options.onUnauthorized ?? signInAgain)();
    throw new ApiV1Error(res.status, await errorText(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
