// Body-free errors for third-party calls and database steps (#331, ADR-0017 O3).
//
// A provider's response body can quote mail, file names or folder names, and a
// PostgREST message can quote the input that failed. Neither may reach a log
// line, a thrown message or a response. Errors become a status and a code at
// the boundary that talks to the provider; everything past that boundary
// carries only the code. Modelled on GraphHttpError (src/lib/graph/http.ts).

export type UpstreamProvider = 'box' | 'resend' | 'graph-mail' | 'gmail-token' | 'gmail-send' | 'anthropic' | 'ignatious';

// A code is a short token. Anything else (a sentence, a name, a path) is not a code.
const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

export function codeShaped(value: unknown): string | null {
  return typeof value === 'string' && CODE_SHAPE.test(value) ? value : null;
}

/** A third-party call that failed. Status, the provider's error code and request id; never a body. */
export class UpstreamHttpError extends Error {
  readonly provider: UpstreamProvider;
  readonly op: string;
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(
    provider: UpstreamProvider,
    op: string,
    status: number,
    code: string | null = null,
    requestId: string | null = null,
  ) {
    const safeCode = codeShaped(code);
    super(`${provider} ${op} failed: ${status}${safeCode ? ` ${safeCode}` : ''}`);
    this.name = 'UpstreamHttpError';
    this.provider = provider;
    this.op = op;
    this.status = status;
    this.code = safeCode;
    this.requestId = codeShaped(requestId);
  }
}

/**
 * An error whose message is first-party copy written in this repo, so it is
 * safe to log and to show. The message is a fixed string; never interpolate
 * input, a provider response or a database message into it.
 */
export class OperatorCopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorCopyError';
  }
}

/**
 * Reads only a code-shaped field from an error response, else null. Looks at
 * the shapes the providers use: `{ code }` (Box), `{ error: { code | type } }`
 * (Graph, Anthropic), `{ error: '<code>' }` (OAuth) and `{ name }` (Resend).
 * The body is consumed here and never returned, so a caller cannot forward it.
 */
export async function upstreamErrorCode(res: Response): Promise<string | null> {
  try {
    return errorCodeFromBody(await res.json());
  } catch {
    return null;
  }
}

/** The code-shaped field of an already-parsed error body, by the precedence upstreamErrorCode reads. */
export function errorCodeFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === 'object' ? (record.error as Record<string, unknown>) : null;
  return (
    codeShaped(record.code) ??
    codeShaped(nested?.code) ??
    codeShaped(nested?.type) ??
    codeShaped(record.error) ??
    codeShaped(record.name)
  );
}

/** A failed database step. The message carries the step and the code, never the database's own text. */
export class DbError extends Error {
  readonly code: string | null;

  constructor(step: string, code: string | null) {
    const safeCode = codeShaped(code);
    super(`${step} failed (${safeCode ?? 'unexpected'})`);
    this.name = 'DbError';
    this.code = safeCode;
  }
}

// A SQL function that raises on purpose (`raise exception 'name_taken'`) answers SQLSTATE
// P0001 with that token as its message. The token is this repo's own code, written in a
// migration, so it is kept as the code: callers that branch on it (the saved-rail errors)
// keep working. Anything with spaces or capitals is a sentence the database wrote, not a token.
const RAISED_CODE = /^[a-z][a-z0-9_]{1,63}$/;

function raisedCode(err: { code?: string | null; message?: string | null } | null): string | null {
  return err?.code === 'P0001' && typeof err.message === 'string' && RAISED_CODE.test(err.message) ? err.message : null;
}

/** Wraps a PostgREST or pg error as a DbError, keeping only its code (or the code a SQL function raised). */
export function dbFailure(step: string, err: { code?: string | null; message?: string | null } | null): DbError {
  return new DbError(step, raisedCode(err) ?? codeShaped(err?.code));
}

// The other body-free provider errors that carry a status, by class name. Matched by
// name and not by import: the Google client imports codeShaped from here, so an
// import back would be a cycle. The server logger reads the same map (src/lib/log/requestError.ts).
export const STATUS_ERROR_PROVIDERS: Readonly<Record<string, string>> = {
  GoogleHttpError: 'google',
  GoogleTokenError: 'google-token',
  GraphHttpError: 'graph',
  IgnatiousRequestError: 'ignatious',
};

function providerStatusCode(err: object): string | null {
  const { name, status } = err as { name?: unknown; status?: unknown };
  if (typeof name !== 'string' || !Object.hasOwn(STATUS_ERROR_PROVIDERS, name)) return null;
  return Number.isInteger(status) ? `${STATUS_ERROR_PROVIDERS[name]}_${status as number}` : null;
}

/**
 * For logs and fixed-copy responses: an UpstreamHttpError becomes
 * `${provider}_${status}`, a pg or PostgREST error its `code`, a Google, Graph
 * or Ignatious error without a code `${provider}_${status}`, anything else
 * 'unexpected'. The result is always code-shaped.
 */
export function errorCodeOf(err: unknown): string {
  if (err instanceof UpstreamHttpError) return `${err.provider}_${err.status}`;
  if (!err || typeof err !== 'object') return 'unexpected';
  const code = 'code' in err ? codeShaped((err as { code?: unknown }).code) : null;
  return code ?? providerStatusCode(err) ?? 'unexpected';
}
