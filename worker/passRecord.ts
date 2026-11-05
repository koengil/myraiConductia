// The reader pass record (#370). One pass per discovery reader attempt: a started
// event before anything else runs, and a finished event in a finally. Both go
// through discovery_record_reader_pass(), which accepts ids, codes, counts and
// UTC times only. A start that cannot be written (each send bounded to 10 s, one
// retry with the same passId; an identical start already written is a success)
// stops the attempt before any read. The end is always attempted (5 s bound); only
// that RPC's failure is logged as a code and swallowed, so the attempt's own return
// or throw, and pg-boss's retry, stand: an audit failure never re-reads mail.
//
// Part of the classification zone (no model call, ESLint fence). It never imports
// the exclusion policy or a reader: errors are matched by name, as errorSummary does.

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  READER_MODE,
  READER_PASS_REASON,
  READER_PASS_STATUS,
  type MailboxProvider,
  type ReaderMode,
  type ReaderPassStatus,
} from '@/lib/constants/discovery';
import type { ContentSource, ReaderRegistrationRef } from '@/lib/discovery/source/types';
import { codeShaped, dbFailure, errorCodeOf } from '@/lib/errors/upstream';
import { normalizeThumbprint } from '@/lib/graph/registration';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess/guard';

import type { SyncResult } from './sync';

export const RECORD_READER_PASS_RPC = 'discovery_record_reader_pass';
export const START_TIMEOUT_MS = 10_000; // R2-M4
export const FINISH_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What one attempt did, written in place by syncSource so a throw still reports it. */
export type PassCounts = { pages: number; fetched: number; excluded: number; stored: number; checkpointAdvanced: boolean };
export const emptyCounts = (): PassCounts => ({ pages: 0, fetched: 0, excluded: 0, stored: 0, checkpointAdvanced: false });

export type PassOutcome = { status: ReaderPassStatus; reason: string | null };
/** The handler's result and readOneSource's: SyncResult's statuses, plus the ones decided before a read. */
export type PassResult = {
  status: SyncResult['status'] | 'skipped' | 'disabled' | 'refused';
  reason?: string;
  skipReason?: string;
};

export type WorkerIdentity = { deployment: string; revision: string | null };

/**
 * DISCOVERY_WORKER_DEPLOYMENT names the deployment (#344's OpenTofu sets it). Unset or not code-shaped, the
 * worker does not know where it runs: 'unknown', or 'local' for the fixture reader only (R1-m4). REVISION is
 * #344's 40-hex build sha, written next to the bundle.
 */
export function workerIdentity(
  mode: ReaderMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): WorkerIdentity {
  const named = codeShaped(env.DISCOVERY_WORKER_DEPLOYMENT?.trim());
  let sha = '';
  try {
    const file = path.join(cwd, 'REVISION');
    sha = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  } catch {
    sha = '';
  }
  return {
    deployment: named ?? (mode === READER_MODE.FIXTURE ? 'local' : 'unknown'),
    revision: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
  };
}

/** The registration's public ids, normalized; a field that cannot be normalized is null, never an error (R1-M4). */
export function toRegistrationRef(raw: ReaderRegistrationRef | null | undefined): ReaderRegistrationRef | null {
  if (!raw) return null;
  const clientId = codeShaped(raw.clientId);
  let certThumbprint: string | null = null;
  if (typeof raw.certThumbprint === 'string') {
    try {
      certThumbprint = normalizeThumbprint(raw.certThumbprint);
    } catch {
      certThumbprint = null;
    }
  }
  return clientId || certThumbprint ? { clientId, certThumbprint } : null;
}

export type ReaderPass = {
  passId: string;
  runId: string;
  sourceId: string;
  counts: PassCounts;
  /** Learned as the attempt runs; null when it ended before. */
  attach(details: { provider?: MailboxProvider; reader?: ContentSource }): void;
  /** Once only; never throws. */
  finish(outcome: PassOutcome): Promise<void>;
};

export async function beginPass(
  db: SupabaseClient,
  ids: {
    tenantId: string;
    sourceId: string;
    jobId: string | null;
    runId?: string;
    /** The start time (ms) when the caller fixed it: runOnce gives every source the run start (#370 m1). */
    startedAt?: number;
  },
  worker: WorkerIdentity,
  deps: { now?: () => number } = {},
): Promise<ReaderPass> {
  const now = deps.now ?? Date.now;
  const passId = randomUUID();
  const runId = ids.runId ?? passId;
  // The end always reads the clock itself (finish below).
  const startedMs = ids.startedAt ?? now();
  const head = {
    v: 1,
    passId,
    runId,
    // Never a malformed id: the writer would refuse the start.
    jobId: ids.jobId && UUID.test(ids.jobId) ? ids.jobId : null,
    sourceId: ids.sourceId,
    startedAt: new Date(startedMs).toISOString(),
    worker,
  };
  const args = { p_event: 'started', p_tenant_id: ids.tenantId, p_detail: head };
  const send = async () => {
    try {
      return (await db.rpc(RECORD_READER_PASS_RPC, args).abortSignal(AbortSignal.timeout(START_TIMEOUT_MS))).error;
    } catch (error) {
      return { code: errorCodeOf(error), message: '' };
    }
  };
  // One retry with the same passId and detail. If the first send committed but its answer was lost
  // (or timed out), the writer recognises the identical start and returns success, however late (R1-m2, R2-M4).
  const error = (await send()) && (await send());
  if (error) throw dbFailure('reader pass start', error); // fail closed: nothing is read

  const counts = emptyCounts();
  let provider: MailboxProvider | null = null;
  let reader: ContentSource | null = null;
  let finished = false;
  return {
    passId,
    runId,
    sourceId: ids.sourceId,
    counts,
    attach(details) {
      if (details.provider) provider = details.provider;
      if (details.reader) reader = details.reader;
    },
    async finish(outcome) {
      if (finished) return;
      finished = true;
      // R2-m7: a reader's accessor or the normalizer failing costs only the registration, never the end.
      let registration: ReaderRegistrationRef | null = null;
      try {
        registration = toRegistrationRef(reader?.registration?.());
      } catch {
        registration = null;
      }
      let endedMs = startedMs;
      try {
        endedMs = Math.max(now(), startedMs); // never before the start (R1-M4)
      } catch {
        endedMs = startedMs;
      }
      const detail = {
        ...head,
        provider,
        registration,
        endedAt: new Date(endedMs).toISOString(),
        status: outcome.status,
        // A reason is a code or nothing: anything else becomes 'unexpected', never text.
        reason: outcome.reason === null ? null : (codeShaped(outcome.reason) ?? 'unexpected'),
        pages: counts.pages,
        fetched: counts.fetched,
        excluded: counts.excluded,
        stored: counts.stored,
        checkpointAdvanced: counts.checkpointAdvanced,
      };
      // Always attempted; only the RPC's own failure is caught here.
      try {
        const { error: finishError } = await db
          .rpc(RECORD_READER_PASS_RPC, { p_event: 'finished', p_tenant_id: ids.tenantId, p_detail: detail })
          .abortSignal(AbortSignal.timeout(FINISH_TIMEOUT_MS));
        if (finishError) throw dbFailure('reader pass end', finishError);
      } catch (failure) {
        // The pass then reads "No end recorded", which is the truth.
        console.error(`discovery worker: reader pass end not recorded (${errorCodeOf(failure)})`);
      }
    },
  };
}

/** The one way an attempt runs under a pass: the handler and runOnce both use it (R1-M1). */
export async function runPass<T extends PassResult>(pass: ReaderPass, fn: () => Promise<T>): Promise<T> {
  let outcome: PassOutcome | undefined;
  try {
    const result = await fn();
    outcome = outcomeOfResult(result);
    return result;
  } catch (error) {
    outcome = outcomeOfFailure(error);
    throw error;
  } finally {
    await pass.finish(outcome ?? outcomeOfFailure(undefined));
  }
}

export function outcomeOfResult(result: PassResult): PassOutcome {
  switch (result.status) {
    case 'complete':
      return { status: READER_PASS_STATUS.COMPLETE, reason: null };
    case 'page_limit':
      return { status: READER_PASS_STATUS.PAGE_LIMIT, reason: READER_PASS_REASON.PAGE_LIMIT };
    case 'reset':
      return { status: READER_PASS_STATUS.RESET, reason: READER_PASS_REASON.HISTORY_EXPIRED };
    case 'halted':
      return { status: READER_PASS_STATUS.HALTED, reason: READER_PASS_REASON.HISTORY_WINDOW_EXCEEDED };
    case 'paused':
      return { status: READER_PASS_STATUS.PAUSED, reason: READER_PASS_REASON.FLAG_OFF };
    case 'disabled':
      return { status: READER_PASS_STATUS.DISABLED, reason: READER_PASS_REASON.FLAG_OFF };
    case 'skipped':
      return { status: READER_PASS_STATUS.SKIPPED, reason: result.skipReason ?? null };
    case 'refused':
      return { status: READER_PASS_STATUS.REFUSED, reason: result.reason ?? null };
  }
}

const FAILURE_BY_NAME: Readonly<Record<string, string>> = {
  NoExclusionPolicyError: READER_PASS_REASON.NO_EXCLUSION_POLICY,
  InvalidExclusionPolicyError: READER_PASS_REASON.EXCLUSION_POLICY_INVALID,
  ExclusionNotEnforcedError: READER_PASS_REASON.EXCLUSION_NOT_ENFORCED,
  // AbortSignal.timeout and boundedCallerToken reject with a DOMException named TimeoutError.
  TimeoutError: READER_PASS_REASON.REQUEST_TIMEOUT,
};
// Only a refusal by Google's token endpoint is a delegation refusal; a 5xx is an outage (R2-m11).
const DELEGATION_REFUSAL_STATUSES = new Set([400, 401, 403]);
// The worker's own failures end in a fixed '… failed (CODE)': the persist and sync steps, the lookups
// in classify.ts and DbError, e.g. 'reader pass start failed (reader_pass_clock_skew)' (R2-m11).
const STEP_FAILURE = /failed \(([A-Za-z0-9_.-]{1,64})\)$/;

/** A throw becomes a fixed code, never a message (R1-m3, R2-m11). */
export function outcomeOfFailure(error: unknown): PassOutcome {
  const failed = (reason: string): PassOutcome => ({ status: READER_PASS_STATUS.FAILED, reason });
  if (error instanceof MailboxAccessRefusedError) return failed(error.reason); // no_capability
  const name = error instanceof Error ? error.name : '';
  if (Object.hasOwn(FAILURE_BY_NAME, name)) return failed(FAILURE_BY_NAME[name]);
  if (name === 'GoogleTokenError') {
    const status = (error as { status?: unknown }).status;
    return failed(
      typeof status === 'number' && DELEGATION_REFUSAL_STATUSES.has(status)
        ? READER_PASS_REASON.DELEGATION_REFUSED
        : errorCodeOf(error),
    );
  }
  const step = error instanceof Error ? STEP_FAILURE.exec(error.message)?.[1] : undefined;
  return failed(step ?? errorCodeOf(error));
}
