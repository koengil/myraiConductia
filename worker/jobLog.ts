// The worker's own job log and its pg-boss failure output (#344, design R12 and
// R13). Part of the classification zone: no model is reachable from here
// (ESLint fence), and it imports nothing but ./sync.
//
// Two leaks it closes:
//   - pg-boss 12 serializes a thrown handler error (name, message, stack and
//     own properties) into pgboss.job.output and keeps it for 7 days. A
//     PostgREST message quoted into `discovery persist: …` can carry values, so
//     a failed job rethrows WorkerJobError(code) instead: the same fixed codes
//     errorSummary gives the admin's last_error, and nothing else (no cause).
//   - The worker printed raw error text on stdout and stderr. Every line it now
//     prints for a job, a tick, a queue error or a fatal exit is one JSON object
//     of ids, codes and counts (the A7 per-mailbox read log), written by
//     logEvent and nowhere else. Strings in a line are checked against a
//     code shape, so an address or a sentence never reaches the log even when a
//     caller passes one.
//
// When #331 lands first, logEvent delegates to its logSafe (thread T1).

import { errorSummary, SYNC_ERROR } from './sync';

export type JobEvent = 'tick' | 'sync' | 'discover' | 'census';

/** One line on stdout: ids, codes and counts only, never message text from any error. */
export type JobLine =
  | { evt: 'tick'; queued?: number; status?: 'failed'; reason?: string }
  | {
      evt: 'sync';
      tenant: string;
      source: string;
      status: string;
      pages?: number;
      fetched?: number;
      excluded?: number;
      stored?: number;
      /** Incoming-mail screening (plan v5 W3): messages the send-time rules read, and how many they flag. Counts only. */
      screened?: number;
      flagged?: number;
      /** Sightings the mailbox had already processed under the same digest and rules (#461). A count. */
      unchanged?: number;
      reason?: string;
    }
  | { evt: 'discover'; tenant: string; candidates?: number; status?: 'failed'; reason?: string }
  | { evt: 'census'; tenants?: number; rows?: number; failed?: number; unattributed?: number; status?: 'failed'; reason?: string }
  // A tenant's census refresh or deal-contact lookup that failed: its id and a fixed code only.
  | { evt: 'census' | 'census_contacts'; tenant: string; status: 'failed'; reason: string }
  | { evt: 'queue_error' | 'fatal'; reason: string }
  // The tick's deletion steps (#461): a step that failed (no id).
  | { evt: 'orphan_collection_failed' | 'group_removal_failed' | 'accept_expiry_failed' }
  // An accept request step in a SYNC job (G-02b #173): how many requests the job claimed and finished, or why it failed.
  // `request` names the one request whose step failed (its id), when the job went on with the others.
  | { evt: 'accept'; tenant: string; source: string; request?: string; claimed?: number; finished?: number; status?: 'failed'; reason?: string }
  // A tenant the group-removal breaker holds (a notice), or holds past 24 hours (overdue): its id and due count only.
  | { evt: 'group_removal_held' | 'group_removal_overdue'; tenant: string; due: number };

/** What a failed job leaves in pgboss.job.output: {name: 'WorkerJobError', message: <code>, stack}. */
export class WorkerJobError extends Error {
  override readonly name = 'WorkerJobError';
  constructor(code: string) {
    super(code);
  }
}

/** The ids a job line names: the job's own tenant and source. */
export type JobIds = { tenant?: string; source?: string };

/** What a handler returns that the line may carry. Anything else in the result is never logged. */
type JobOutcome = {
  queued?: number;
  status?: string;
  pages?: number;
  fetched?: number;
  excluded?: number;
  stored?: number;
  screened?: number;
  flagged?: number;
  unchanged?: number;
  reason?: string;
  skipReason?: string;
  candidates?: number;
  tenants?: number;
  rows?: number;
  failed?: number;
  unattributed?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A fixed code: a refusal reason, a SYNC_ERROR code, 'Graph 429 TooManyRequests (throttled)', 'Google 403 rateLimitExceeded', a class name. */
const CODE = /^[A-Za-z0-9][A-Za-z0-9 _.:()-]{0,79}$/;
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const INVALID = 'invalid';

/** An id as the line prints it: a UUID, else the fixed word `invalid` (job data is never echoed). */
function idOf(value: string | undefined): string {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : INVALID;
}

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return CODE.test(value) ? value : INVALID;
}

/** A failure's fixed code, or 'Worker error' when the code is not code-shaped. */
function failureCodeOf(code: string): string {
  return CODE.test(code) ? code : SYNC_ERROR.WORKER;
}

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Drops every key whose value is undefined, so a line names only what it has. */
function compact<T extends Record<string, unknown>>(line: T): T {
  return Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined)) as T;
}

/**
 * The code a queue error or a fatal exit prints: errorSummary's code when it
 * names the failure, else the error's class name when it is a plain
 * identifier (WorkerSecretKeyShapeError, DatabaseError), else 'Worker error'.
 * Never a message.
 */
export function failureReason(error: unknown): string {
  const summary = errorSummary(error);
  if (summary !== SYNC_ERROR.WORKER) return failureCodeOf(summary);
  const name = error instanceof Error ? error.name : undefined;
  return name && name !== 'Error' && CLASS_NAME.test(name) ? name : SYNC_ERROR.WORKER;
}

/** The only writer of the worker's JSON lines: one object per line on stdout. */
export function logEvent(line: JobLine): void {
  if (line.evt === 'census_contacts' || (line.evt === 'census' && 'tenant' in line)) {
    process.stdout.write(`${JSON.stringify({ evt: line.evt, tenant: idOf(line.tenant), status: 'failed', reason: codeOf(line.reason) ?? INVALID })}\n`);
    return;
  }
  if (line.evt === 'accept') {
    process.stdout.write(
      `${JSON.stringify(
        compact({
          evt: 'accept',
          tenant: idOf(line.tenant),
          source: idOf(line.source),
          request: line.request === undefined ? undefined : idOf(line.request),
          claimed: countOf(line.claimed),
          finished: countOf(line.finished),
          status: line.status,
          reason: line.reason === undefined ? undefined : (codeOf(line.reason) ?? INVALID),
        }),
      )}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(compact(line as Record<string, unknown>))}\n`);
}

function lineOf(evt: JobEvent, ids: JobIds, outcome: JobOutcome): JobLine {
  switch (evt) {
    case 'tick':
      return compact({ evt, queued: countOf(outcome.queued) });
    case 'sync':
      return compact({
        evt,
        tenant: idOf(ids.tenant),
        source: idOf(ids.source),
        status: codeOf(outcome.status) ?? INVALID,
        pages: countOf(outcome.pages),
        fetched: countOf(outcome.fetched),
        excluded: countOf(outcome.excluded),
        stored: countOf(outcome.stored),
        screened: countOf(outcome.screened),
        flagged: countOf(outcome.flagged),
        unchanged: countOf(outcome.unchanged),
        reason: codeOf(outcome.reason ?? outcome.skipReason),
      });
    case 'discover':
      return compact({ evt, tenant: idOf(ids.tenant), candidates: countOf(outcome.candidates) });
    case 'census':
      return compact({ evt, tenants: countOf(outcome.tenants), rows: countOf(outcome.rows), failed: countOf(outcome.failed), unattributed: countOf(outcome.unattributed) });
  }
}

function failedLineOf(evt: JobEvent, ids: JobIds, reason: string): JobLine {
  switch (evt) {
    case 'tick':
      return { evt, status: 'failed', reason };
    case 'sync':
      return { evt, tenant: idOf(ids.tenant), source: idOf(ids.source), status: 'failed', reason };
    case 'discover':
      return { evt, tenant: idOf(ids.tenant), status: 'failed', reason };
    case 'census':
      return { evt, status: 'failed', reason };
  }
}

/**
 * Runs one pg-boss job's handler. Success: one line from its result, and the
 * result goes back to pg-boss unchanged. Failure: one line with the fixed code,
 * then WorkerJobError(code) is thrown, so pg-boss retries the job as before and
 * stores the code, never the error it caught.
 */
export async function runJob<T extends JobOutcome>(evt: JobEvent, ids: JobIds, fn: () => Promise<T>): Promise<T> {
  let outcome: T;
  try {
    outcome = await fn();
  } catch (error) {
    const reason = failureCodeOf(errorSummary(error));
    logEvent(failedLineOf(evt, ids, reason));
    throw new WorkerJobError(reason);
  }
  logEvent(lineOf(evt, ids, outcome));
  return outcome;
}
