// A failed audit_log write, logged (#474, design Q4). Routes insert audit rows
// directly through the admin client, and not all of them report a rejected row, so
// the admin client's fetch watches every POST to /rest/v1/audit_log instead. The
// request and the response pass through untouched: the caller gets the same
// Response, or the same rejection, and the observer never throws on its own. The line
// carries the HTTP status and, from a bounded read of the PostgREST error body, only its
// code, which the logger keeps when it is a known SQLSTATE. Audit rows written inside an
// RPC are not seen here (a known limit).

import { logServerEvent, type LineFor } from '@/lib/log';

type Sqlstate = LineFor<'audit_write_failed'>['sqlstate'];

const AUDIT_LOG_PATH = '/rest/v1/audit_log';

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function isAuditInsert(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  const method: unknown = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (typeof method !== 'string' || method.toUpperCase() !== 'POST') return false;
  const path = urlOf(input).split(/[?#]/, 1)[0];
  return path.endsWith(AUDIT_LOG_PATH);
}

// The error body is read for its code only within these bounds; past either, the line
// goes without a sqlstate. A PostgREST error body is a few hundred bytes.
const BODY_READ_MS = 250;
const BODY_MAX_BYTES = 4096;

/** A clone's text, or undefined past the time or size bound. The caller's body is untouched. */
async function boundedText(res: Response): Promise<string | undefined> {
  const body = res.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), BODY_READ_MS);
  });
  let text = '';
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === 'late') return undefined;
      if (next.done) return text + decoder.decode();
      size += next.value.byteLength;
      if (size > BODY_MAX_BYTES) return undefined;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    // Not awaited: cancelling one branch of a tee settles only when the caller's branch ends too.
    reader.cancel().catch(() => {});
  }
}

/** The PostgREST error code of a failed response, read from a bounded clone. */
async function sqlstateOf(res: Response): Promise<Sqlstate> {
  try {
    const text = await boundedText(res);
    if (text === undefined) return undefined;
    const body: unknown = JSON.parse(text);
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    // A code outside SQLSTATES is written as 'invalid' by the logger's cleaner.
    return typeof code === 'string' ? (code as Sqlstate) : undefined;
  } catch {
    return undefined;
  }
}

/** Runs the observer's own work; a failure in it never reaches the caller. */
async function quietly(work: () => void | Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // The write's outcome is the caller's; a logging failure is not.
  }
}

export function observeAuditWrites(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    let observed = false;
    try {
      observed = isAuditInsert(input, init);
    } catch {
      observed = false;
    }
    if (!observed) return inner(input, init);
    let res: Response;
    try {
      res = await inner(input, init);
    } catch (error) {
      // The database could not be reached (network failure, abort, timeout).
      await quietly(() => logServerEvent({ evt: 'audit_write_failed', status: 0 }));
      throw error;
    }
    if (!res.ok) {
      await quietly(async () => logServerEvent({ evt: 'audit_write_failed', status: res.status, sqlstate: await sqlstateOf(res) }));
    }
    return res;
  };
}
