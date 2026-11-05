// @vitest-environment node
import { describe, expect, it } from 'vitest';

// The reader pass record's pure parts (#370): the registration normalizer, the worker identity and the mapping of
// a throw to a fixed code. None of them may ever put text that is not a code into a pass event.

import { READER_MODE } from '@/lib/constants/discovery';
import { DbError } from '@/lib/errors/upstream';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess/guard';
import { outcomeOfFailure, outcomeOfResult, toRegistrationRef, workerIdentity } from '../../worker/passRecord';

const SHA1 = 'ab'.repeat(20);
const SHA256 = 'cd'.repeat(32);
const FIXTURES = 'tests/fixtures/reader-pass';

describe('toRegistrationRef', () => {
  it('normalizes a thumbprint with colons, whitespace or capitals', () => {
    const colons = SHA1.toUpperCase().match(/../g)!.join(':');
    expect(toRegistrationRef({ clientId: 'app-1', certThumbprint: colons })).toEqual({ clientId: 'app-1', certThumbprint: SHA1 });
    expect(toRegistrationRef({ clientId: null, certThumbprint: ` ${SHA256.match(/.{8}/g)!.join(' ')} ` })).toEqual({
      clientId: null,
      certThumbprint: SHA256,
    });
  });

  it('turns a thumbprint it cannot normalize into null, never an error', () => {
    expect(toRegistrationRef({ clientId: 'app-1', certThumbprint: 'a'.repeat(39) })).toEqual({ clientId: 'app-1', certThumbprint: null });
  });

  it('turns a clientId that is not code-shaped into null', () => {
    expect(toRegistrationRef({ clientId: 'reader@bank.example is me', certThumbprint: SHA1 })).toEqual({ clientId: null, certThumbprint: SHA1 });
  });

  it('gives null when neither field survives, or when there is no registration', () => {
    expect(toRegistrationRef({ clientId: 'not a code', certThumbprint: 'xyz' })).toBeNull();
    expect(toRegistrationRef(null)).toBeNull();
    expect(toRegistrationRef(undefined)).toBeNull();
  });
});

describe('workerIdentity', () => {
  const empty = `${FIXTURES}/none`;

  it('is unknown when unset in live mode, and local for the fixture reader only (R1-m4)', () => {
    expect(workerIdentity(READER_MODE.LIVE, {}, empty)).toEqual({ deployment: 'unknown', revision: null });
    expect(workerIdentity(READER_MODE.GRAPH, {}, empty)).toEqual({ deployment: 'unknown', revision: null });
    expect(workerIdentity(READER_MODE.FIXTURE, {}, empty)).toEqual({ deployment: 'local', revision: null });
  });

  it('keeps a code-shaped DISCOVERY_WORKER_DEPLOYMENT, and refuses anything else', () => {
    expect(workerIdentity(READER_MODE.LIVE, { DISCOVERY_WORKER_DEPLOYMENT: 'aws-ignatious' }, empty).deployment).toBe('aws-ignatious');
    expect(workerIdentity(READER_MODE.LIVE, { DISCOVERY_WORKER_DEPLOYMENT: 'bad value!' }, empty).deployment).toBe('unknown');
    expect(workerIdentity(READER_MODE.FIXTURE, { DISCOVERY_WORKER_DEPLOYMENT: 'bad value!' }, empty).deployment).toBe('local');
  });

  it('reads a 40-hex REVISION file next to the bundle, and nothing else', () => {
    expect(workerIdentity(READER_MODE.LIVE, {}, `${FIXTURES}/revision-ok`).revision).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(workerIdentity(READER_MODE.LIVE, {}, `${FIXTURES}/revision-bad`).revision).toBeNull();
  });
});

describe('outcomeOfResult', () => {
  it.each([
    [{ status: 'complete' as const }, 'complete', null],
    [{ status: 'page_limit' as const }, 'page_limit', 'page_limit'],
    [{ status: 'reset' as const }, 'reset', 'history_expired'],
    [{ status: 'halted' as const }, 'halted', 'history_window_exceeded'],
    [{ status: 'paused' as const }, 'paused', 'flag_off'],
    [{ status: 'disabled' as const }, 'disabled', 'flag_off'],
    [{ status: 'skipped' as const, skipReason: 'source_inactive' }, 'skipped', 'source_inactive'],
    [{ status: 'skipped' as const }, 'skipped', null],
    [{ status: 'refused' as const, reason: 'no_consent' }, 'refused', 'no_consent'],
  ])('%o → %s / %s', (result, status, reason) => {
    expect(outcomeOfResult(result)).toEqual({ status, reason });
  });
});

describe('outcomeOfFailure: a throw becomes a fixed code, never a message (R1-m3, R2-m11)', () => {
  const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('Re: Project Falcon, from a@bank.example'), { name, ...extra });

  it.each([
    [new Error('discovery persist: source_items upsert failed (23P01)'), '23P01'],
    [new Error('discovery sync: checkpoint update failed (P0001)'), 'P0001'],
    [new Error('registration lookup failed (PGRST301)'), 'PGRST301'],
    [new Error('content source lookup failed (08006)'), '08006'],
    [new Error('reader pass start failed (reader_pass_clock_skew)'), 'reader_pass_clock_skew'],
    [named('GoogleTokenError', { status: 400 }), 'delegation_refused'],
    [named('GoogleTokenError', { status: 401 }), 'delegation_refused'],
    [named('GoogleTokenError', { status: 403 }), 'delegation_refused'],
    [named('GoogleTokenError', { status: 503 }), 'google-token_503'],
    [named('NoExclusionPolicyError'), 'no_exclusion_policy'],
    [named('InvalidExclusionPolicyError'), 'exclusion_policy_invalid'],
    [named('ExclusionNotEnforcedError'), 'exclusion_not_enforced'],
    [named('GoogleHttpError', { status: 500 }), 'google_500'],
    [new DbError('registration lookup', 'PGRST301'), 'PGRST301'],
    [new MailboxAccessRefusedError('t', 'a@bank.example', 'no_capability', 'provider_read'), 'no_capability'],
    [new Error('anything else, with a subject in it'), 'unexpected'],
    ['a string', 'unexpected'],
    [undefined, 'unexpected'],
  ])('%s → failed / %s', (error, reason) => {
    expect(outcomeOfFailure(error)).toEqual({ status: 'failed', reason });
  });

  it('a TimeoutError DOMException (AbortSignal.timeout, boundedCallerToken) is failed / request_timeout', () => {
    expect(outcomeOfFailure(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toEqual({
      status: 'failed',
      reason: 'request_timeout',
    });
  });

  it('never matches a step code that is not at the end, nor one that is not code-shaped', () => {
    expect(outcomeOfFailure(new Error('x failed (a b) and more')).reason).toBe('unexpected');
    expect(outcomeOfFailure(new Error('x failed (a@b c)')).reason).toBe('unexpected');
  });

  it('does not take a name from the prototype chain as a known failure', () => {
    expect(outcomeOfFailure(named('toString')).reason).toBe('unexpected');
  });
});
