// An uncaught request error, reduced to its class (#474, design Q2/Q4). It reads the
// thrown value's class, a DbError's SQLSTATE and an upstream error's provider and
// status, and never its message or stack: a library's message can quote its input
// (JSON.parse quotes the text it failed on, thread T7). The route is not carried;
// the platform's request record holds the path (Q2).

import { DbError, STATUS_ERROR_PROVIDERS, UpstreamHttpError } from '@/lib/errors/upstream';

import type { LineFor } from './fields';
import { ERROR_CLASSES } from './values';

type RequestErrorLine = LineFor<'request_error'>;
type Decomposed = Pick<RequestErrorLine, 'errorClass' | 'provider' | 'status' | 'sqlstate'>;

// A P0001 raise keeps this repo's own snake_case token as the DbError code (upstream.ts).
// The token is not logged, only the SQLSTATE it came with.
const RAISE_TOKEN = /^[a-z][a-z0-9_]*$/;

// Classes a line names as themselves; 'db', 'upstream' and 'other' are decided below.
const NAMED_CLASSES: ReadonlySet<string> = new Set(
  ERROR_CLASSES.filter((c) => c !== 'db' && c !== 'upstream' && c !== 'other'),
);

/**
 * The request_error line for a thrown value. Next types the method as a plain
 * string, and a DbError code or a provider name is a string too: the casts below
 * only name the field, and the cleaner writes a value outside its set as 'invalid'.
 */
export function requestErrorLine(err: unknown, method: string, routeType: RequestErrorLine['routeType']): RequestErrorLine {
  return { evt: 'request_error', routeType, method: method as RequestErrorLine['method'], ...decompose(err) };
}

function decompose(err: unknown): Decomposed {
  // By name as well as by class: Next bundles instrumentation apart from the routes, so a
  // route's DbError need not be an instance of the class imported here.
  const name = nameOf(err);
  if (err instanceof DbError || name === 'DbError') {
    const { code } = err as { code?: unknown };
    if (typeof code !== 'string') return { errorClass: 'db' };
    const sqlstate = RAISE_TOKEN.test(code) ? 'P0001' : code;
    return { errorClass: 'db', sqlstate: sqlstate as Decomposed['sqlstate'] };
  }
  if (err instanceof UpstreamHttpError || name === 'UpstreamHttpError') {
    const { provider, status } = err as { provider?: unknown; status?: unknown };
    return {
      errorClass: 'upstream',
      provider: provider as Decomposed['provider'],
      status: Number.isInteger(status) ? (status as number) : undefined,
    };
  }
  if (name !== null && Object.hasOwn(STATUS_ERROR_PROVIDERS, name)) {
    const status = (err as { status?: unknown }).status;
    return {
      errorClass: 'upstream',
      provider: STATUS_ERROR_PROVIDERS[name] as Decomposed['provider'],
      status: Number.isInteger(status) ? (status as number) : undefined,
    };
  }
  return { errorClass: name !== null && NAMED_CLASSES.has(name) ? (name as Decomposed['errorClass']) : 'other' };
}

function nameOf(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const { name } = err as { name?: unknown };
  return typeof name === 'string' ? name : null;
}
