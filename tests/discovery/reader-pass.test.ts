// @vitest-environment node
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The reader pass record (#370): every discovery reader attempt, through the queue handler or runOnce, leaves a
// started event before anything else runs and a finished event with its outcome and counts. The guard, the reader
// and the mirror are stubbed at the @/lib/mailboxAccess door, and syncSource takes its behaviour per test from
// `sync.impl`; what is under test is the pass the worker records around them.
const access = vi.hoisted(() => ({
  readableMailboxes: vi.fn(),
  guardedContentSource: vi.fn(),
  createGuardedContentSource: vi.fn(),
}));
vi.mock('@/lib/mailboxAccess', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mailboxAccess')>('@/lib/mailboxAccess');
  return {
    ...actual,
    readableMailboxes: access.readableMailboxes,
    guardedContentSource: access.guardedContentSource,
    createGuardedContentSource: access.createGuardedContentSource,
    createFixtureAllowlistMirror: () => ({ listMembers: async () => [] }),
    createLiveAllowlistMirror: () => ({ listMembers: async () => [] }),
  };
});
const flags = vi.hoisted(() => ({ discovery: true, throws: null as Error | null }));
// Every step a run takes, in order: the flag read, each table read, each pass event, the routing context (m2).
const trace = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/flags/isEnabled', () => ({
  // The demo flag behind model proposals (G-02b #173) stays off here: the accept step has its own suite
  // (accept-step.test.ts, accept-job.test.ts), and a claim here would add an rpc to every run this file counts.
  isEnabled: async (key: string) => {
    trace.push('flag');
    if (flags.throws) throw flags.throws;
    return key === 'discovery_model_proposals_demo' ? false : flags.discovery;
  },
}));
const contacts = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/discovery/sendCensus/load', () => ({ loadDealContacts: contacts.load }));

type SyncArgs = Parameters<typeof import('../../worker/sync').syncSource>[1];
const sync = vi.hoisted(() => ({
  impl: null as null | ((args: SyncArgs) => Promise<unknown>),
  order: [] as string[],
  contextThrows: null as Error | null,
}));
vi.mock('../../worker/sync', async () => {
  const actual = await vi.importActual<typeof import('../../worker/sync')>('../../worker/sync');
  return {
    ...actual,
    loadRoutingContext: async () => {
      sync.order.push('context');
      trace.push('context');
      if (sync.contextThrows) throw sync.contextThrows;
      return new actual.RoutingContext();
    },
    discoverTenant: async () => [],
    syncSource: async (_db: unknown, args: SyncArgs) => {
      sync.order.push(`sync:${args.source.id}`);
      // Incoming-mail screening counts (plan v5 W3) and the routing tally (#460) default to none; a test's own result can set them.
      const none = { screening: { screened: 0, flagged: 0 }, routing: actual.emptyRoutingTally(), fullRead: false };
      if (sync.impl) return { ...none, ...((await sync.impl(args)) as object) };
      args.counts!.pages = 1;
      args.counts!.stored = 2;
      args.counts!.checkpointAdvanced = true;
      return { ...none, status: 'complete', mode: 'backfill', pages: 1, itemsRead: 2, storedKeys: new Set(['a', 'b']), checkpointAdvanced: true, fetched: 0, excluded: 0 };
    },
  };
});

import {
  GROUP_REMOVAL_BREAKER,
  GROUP_REMOVAL_BREAKER_ACTIVE,
  MAILBOX_PROVIDER,
  READER_MODE,
  type MailboxProvider,
} from '@/lib/constants/discovery';
import { SEND_CENSUS_WEEKS } from '@/lib/constants/sendCensus';
import { SourceArchivedError } from '@/lib/discovery/persist';
import { DbError } from '@/lib/errors/upstream';
import { MailboxAccessRefusedError, UnsupportedSourceError } from '@/lib/mailboxAccess';
import { createWorkerHandlers, runOnce } from '../../worker/classify';
import { beginPass, FINISH_TIMEOUT_MS, START_TIMEOUT_MS } from '../../worker/passRecord';
import { recordingRpc, type RpcAnswer } from '../helpers/readerPassRpc';

const TENANT = '11111111-1111-4111-8111-111111111111';
const S1 = '33333333-3333-4333-8333-333333333331';
const S2 = '33333333-3333-4333-8333-333333333332';
const S3 = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const DATA = { tenantId: TENANT, sourceId: S1 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SourceSpec = { id: string; provider: MailboxProvider; kind?: 'mailbox' | 'sharepoint_site'; lastError?: string | null };

/** A fake service client: the active registration tables, the active sources, and a recording rpc. */
function fakeDb(options: { active?: string[]; sources?: SourceSpec[]; answers?: RpcAnswer[]; failTable?: string } = {}) {
  const active = options.active ?? ['graph_reader_registrations'];
  const sources = options.sources ?? [{ id: S1, provider: 'microsoft' }];
  const recorder = recordingRpc(options.answers ?? []);
  const updates: Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const from = vi.fn((table: string) => {
    trace.push(`from:${table}`);
    let rows: unknown[] = [];
    const filters: Array<[string, unknown]> = [];
    if (table === 'content_sources') {
      rows = sources.map((s) => ({
        id: s.id,
        tenant_id: TENANT,
        kind: s.kind ?? 'mailbox',
        provider: s.provider,
        address: `${s.id.slice(-1)}@bank.example`,
        owner_user_id: null,
        delta_checkpoint: null,
        last_error: s.lastError ?? null,
      }));
    } else if (table === 'feature_flags') {
      rows = [{ enabled: true }];
    } else if (active.includes(table)) {
      rows = [{ tenant_id: TENANT }];
    }
    const matching = () =>
      (rows as Array<Record<string, unknown>>).filter((row) =>
        filters.every(([column, value]) => !(column in row) || row[column] === value),
      );
    const builder: Record<string, unknown> = {
      update: (patch: Record<string, unknown>) => {
        updates.push({ table, patch, filters });
        return builder;
      },
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      in: () => builder,
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      range: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: async () =>
        table === options.failTable
          ? { data: null, error: { code: 'PGRST301', message: 'JWT expired' } }
          : { data: matching()[0] ?? null, error: null },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: matching(), error: null }).then(resolve),
    };
    return builder;
  });
  const rpc = (name: string, args: Record<string, unknown>) => {
    trace.push(`${String(args.p_event)}:${String((args.p_detail as { sourceId?: unknown } | undefined)?.sourceId)}`);
    // The tick's accept-expiry call (G-02b) is recorded like every rpc but answers a plain success of its own, so it
    // never takes an answer a test scripted for the backstop or the withdrawal that follow it.
    if (name === 'discovery_expire_model_proposal_accepts') recorder.answers.unshift({ data: null, error: null });
    return recorder.rpc(name, args);
  };
  return { db: { from, rpc } as unknown as SupabaseClient, from, updates, ...recorder };
}

function reader(over: Record<string, unknown> = {}) {
  return {
    kind: 'mailbox',
    backfill: async function* () {
      yield { items: [], nextCheckpoint: null };
    },
    delta: async function* () {},
    ...over,
  };
}

const handlersFor = (db: SupabaseClient, boss = { send: vi.fn() }) =>
  createWorkerHandlers({ db, boss, provider: READER_MODE.FIXTURE });

const pairs = (events: ReturnType<ReturnType<typeof recordingRpc>['events']>) =>
  events.map((e) => [e.event, e.detail.status ?? null, e.detail.reason ?? null]);

describe('weekly census handler (#425)', () => {
  it('refreshes each registered tenant, continuing after a failed tenant', async () => {
    const tenant2 = '22222222-2222-4222-8222-222222222222';
    const calls: Array<{ name: string; args: unknown }> = [];
    const from = (table: string) => {
      const rows = table === 'feature_flags' ? [{ enabled: true }] : [{ tenant_id: TENANT }, { tenant_id: tenant2 }];
      const query: Record<string, unknown> = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: rows[0], error: null }), then: (done: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(done) };
      return query;
    };
    const rpc = async (name: string, args: unknown) => {
      calls.push({ name, args });
      return calls.length === 1 ? { data: null, error: { code: 'XX000' } } : { data: { rows: 5, unattributed: 0 }, error: null };
    };
    const db = { from, rpc } as unknown as SupabaseClient;
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await handlersFor(db).census()).toEqual({ tenants: 2, rows: 5, failed: 1, unattributed: 0 });
    // The failed tenant is named with a code only (Martin's review, point 4).
    expect(output.mock.calls.map(([chunk]) => String(chunk)))
      .toEqual([`${JSON.stringify({ evt: 'census', tenant: TENANT, status: 'failed', reason: 'XX000' })}\n`]);
    expect(calls).toEqual([
      { name: 'send_census_refresh', args: { p_tenant: TENANT, p_weeks: SEND_CENSUS_WEEKS } },
      { name: 'send_census_refresh', args: { p_tenant: tenant2, p_weeks: SEND_CENSUS_WEEKS } },
    ]);
  });
  it('sums unattributed bankers across tenant refreshes', async () => {
    const tenant2 = '22222222-2222-4222-8222-222222222222';
    const from = (table: string) => {
      const rows = table === 'feature_flags' ? [{ enabled: true }] : [{ tenant_id: TENANT }, { tenant_id: tenant2 }];
      const query: Record<string, unknown> = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: rows[0], error: null }), then: (done: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(done) };
      return query;
    };
    const rpc = vi.fn().mockResolvedValueOnce({ data: { rows: 2, unattributed: 3 }, error: null })
      .mockResolvedValueOnce({ data: { rows: 4, unattributed: 1 }, error: null });
    expect(await handlersFor({ from, rpc } as unknown as SupabaseClient).census())
      .toEqual({ tenants: 2, rows: 6, failed: 0, unattributed: 4 });
  });
});

beforeEach(() => {
  flags.discovery = true;
  flags.throws = null;
  trace.length = 0;
  sync.contextThrows = null;
  sync.impl = null;
  sync.order = [];
  access.readableMailboxes.mockReset();
  access.guardedContentSource.mockReset();
  access.createGuardedContentSource.mockReset();
  contacts.load.mockReset();
  contacts.load.mockResolvedValue(undefined);
  access.createGuardedContentSource.mockImplementation((inner: unknown) => inner);
  access.readableMailboxes.mockImplementation(async () => ({
    status: 'in_sync',
    readable: new Set<string>(),
    missingInGroup: [],
    extraInGroup: [],
    providerCheck: () => null,
  }));
  access.guardedContentSource.mockImplementation(() => {
    sync.order.push('reader');
    return reader();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('reader pass, queue handler (#370)', () => {
  it('loads contacts once for a Google provider pass, not for Microsoft', async () => {
    const google = fakeDb({ active: ['google_reader_registrations'], sources: [{ id: S3, provider: 'google' }] });
    const dealContacts = { addresses: new Set(['person@buyer.example']), domains: ['buyer.example'] };
    contacts.load.mockResolvedValue(dealContacts);
    await handlersFor(google.db).sync({ tenantId: TENANT, sourceId: S3 });
    expect(contacts.load).toHaveBeenCalledTimes(1);
    expect(contacts.load).toHaveBeenCalledWith(google.db, TENANT, expect.any(Function));
    expect(access.guardedContentSource).toHaveBeenCalledWith(
      { kind: 'mailbox', provider: 'google' }, READER_MODE.FIXTURE,
      expect.objectContaining({ dealContacts }),
    );
    contacts.load.mockClear();
    const microsoft = fakeDb();
    await handlersFor(microsoft.db).sync(DATA);
    expect(contacts.load).not.toHaveBeenCalled();
  });

  it('logs one code-only contact lookup failure and continues with unclassified mail', async () => {
    const google = fakeDb({ active: ['google_reader_registrations'], sources: [{ id: S3, provider: 'google' }] });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    contacts.load.mockImplementation(async (_db: unknown, _tenant: unknown, onError: (code: string) => void) => {
      onError('XX000');
      return undefined;
    });
    await expect(handlersFor(google.db).sync({ tenantId: TENANT, sourceId: S3 })).resolves.toMatchObject({ status: 'complete' });
    expect(access.guardedContentSource).toHaveBeenCalledWith(
      { kind: 'mailbox', provider: 'google' }, READER_MODE.FIXTURE,
      expect.not.objectContaining({ dealContacts: expect.anything() }),
    );
    const lines = output.mock.calls.map(([chunk]) => String(chunk));
    expect(lines).toEqual([`${JSON.stringify({ evt: 'census_contacts', tenant: TENANT, status: 'failed', reason: 'XX000' })}\n`]);
  });

  it('a completed attempt: a start, then an end with the same passId, runId and jobId, and the counts', async () => {
    const { db, events, rpc } = fakeDb();
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toEqual({ status: 'complete', pages: 1, fetched: 0, excluded: 0, stored: 2, screened: 0, flagged: 0 });
    expect(rpc.mock.calls.every(([name]) => name === 'discovery_record_reader_pass')).toBe(true);
    const [start, end] = events();
    expect(start).toMatchObject({ event: 'started', tenantId: TENANT });
    expect(Object.keys(start.detail).sort()).toEqual(['jobId', 'passId', 'runId', 'sourceId', 'startedAt', 'v', 'worker']);
    expect(start.detail).toMatchObject({ v: 1, jobId: JOB, sourceId: S1, worker: { deployment: 'local', revision: null } });
    expect(start.detail.passId).toMatch(UUID);
    // A queue job's runId is its passId: the ledger rows it writes carry it.
    expect(start.detail.runId).toBe(start.detail.passId);
    expect(end).toMatchObject({
      event: 'finished',
      detail: {
        ...start.detail,
        provider: 'microsoft',
        registration: null,
        status: 'complete',
        reason: null,
        pages: 1,
        fetched: 0,
        excluded: 0,
        stored: 2,
        checkpointAdvanced: true,
      },
    });
    expect(Date.parse(end.detail.endedAt as string)).toBeGreaterThanOrEqual(Date.parse(start.detail.startedAt as string));
  });

  it('hands syncSource the pass runId and its counts', async () => {
    const { db, events } = fakeDb();
    let seen: SyncArgs | undefined;
    sync.impl = async (args) => {
      seen = args;
      return { status: 'complete', mode: 'backfill', pages: 0, itemsRead: 0, storedKeys: new Set(), checkpointAdvanced: false };
    };
    await handlersFor(db).sync(DATA, { jobId: JOB });
    expect(seen?.runId).toBe(events()[0].detail.passId);
    expect(seen?.counts).toEqual({ pages: 0, fetched: 0, excluded: 0, stored: 0, checkpointAdvanced: false });
  });

  it.each([
    ['page_limit', 'page_limit'],
    ['reset', 'history_expired'],
    ['halted', 'history_window_exceeded'],
    ['paused', 'flag_off'],
  ])('maps %s to %s', async (status, reason) => {
    const { db, events } = fakeDb();
    sync.impl = async () => ({ status, mode: 'backfill', pages: 3, itemsRead: 0, storedKeys: new Set(), checkpointAdvanced: true });
    await handlersFor(db).sync(DATA, { jobId: JOB });
    expect(pairs(events())).toEqual([
      ['started', null, null],
      ['finished', status, reason],
    ]);
  });

  it('records disabled as flag_off before any registration or provider lookup', async () => {
    flags.discovery = false;
    const { db, events, from } = fakeDb();
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toEqual({ status: 'disabled' });
    expect(pairs(events())).toEqual([
      ['started', null, null],
      ['finished', 'disabled', 'flag_off'],
    ]);
    expect(events()[1].detail.provider).toBeNull();
    expect(from).not.toHaveBeenCalledWith('graph_reader_registrations');
    expect(access.readableMailboxes).not.toHaveBeenCalled();
  });

  it('records skipped no_provider, source_inactive, unsupported_reader and source_archived', async () => {
    const noProvider = fakeDb({ active: [] });
    await expect(handlersFor(noProvider.db).sync(DATA)).resolves.toEqual({ status: 'skipped', skipReason: 'no_provider' });
    expect(pairs(noProvider.events())[1]).toEqual(['finished', 'skipped', 'no_provider']);

    const gone = fakeDb({ sources: [] });
    await expect(handlersFor(gone.db).sync(DATA)).resolves.toEqual({ status: 'skipped', skipReason: 'source_inactive' });
    expect(pairs(gone.events())[1]).toEqual(['finished', 'skipped', 'source_inactive']);

    const unsupported = fakeDb();
    access.guardedContentSource.mockImplementationOnce(() => {
      throw new UnsupportedSourceError('mailbox', 'microsoft', 'fixture', 'no reader');
    });
    await expect(handlersFor(unsupported.db).sync(DATA)).resolves.toEqual({ status: 'skipped', skipReason: 'unsupported_reader' });
    expect(pairs(unsupported.events())[1]).toEqual(['finished', 'skipped', 'unsupported_reader']);

    const archived = fakeDb();
    sync.impl = async (args) => {
      Object.assign(args.counts!, { pages: 1, fetched: 2, excluded: 0, stored: 2, checkpointAdvanced: true });
      throw new SourceArchivedError();
    };
    // The job line carries what the pass read before the archive stopped it, as the pass record does (R1).
    await expect(handlersFor(archived.db).sync(DATA)).resolves.toEqual({
      status: 'skipped',
      skipReason: 'source_archived',
      pages: 1,
      fetched: 2,
      excluded: 0,
      stored: 2,
    });
    expect(pairs(archived.events())[1]).toEqual(['finished', 'skipped', 'source_archived']);
  });

  it('records a guard refusal with its reason and the counts reached, and registration_inactive', async () => {
    const refused = fakeDb();
    sync.impl = async (args) => {
      Object.assign(args.counts!, { pages: 2, fetched: 5, excluded: 1, stored: 3, checkpointAdvanced: true });
      throw new MailboxAccessRefusedError(TENANT, 'a@bank.example', 'no_consent', 'provider_read');
    };
    // A refusal after completed pages: the job line carries the same counts as the pass end (R1).
    await expect(handlersFor(refused.db).sync(DATA)).resolves.toEqual({
      status: 'refused',
      reason: 'no_consent',
      pages: 2,
      fetched: 5,
      excluded: 1,
      stored: 3,
    });
    expect(refused.events()[1].detail).toMatchObject({
      status: 'refused',
      reason: 'no_consent',
      pages: 2,
      fetched: 5,
      excluded: 1,
      stored: 3,
      checkpointAdvanced: true,
    });

    const inactive = fakeDb({ active: ['google_reader_registrations'] });
    await expect(handlersFor(inactive.db).sync(DATA)).resolves.toEqual({ status: 'refused', reason: 'registration_inactive' });
    expect(inactive.events()[1].detail).toMatchObject({ status: 'refused', reason: 'registration_inactive', provider: 'microsoft' });
  });

  it.each([
    [new Error('discovery persist: source_items upsert failed (23P01)'), '23P01'],
    [new Error('registration lookup failed (PGRST301)'), 'PGRST301'],
    [new Error('content source lookup failed (08006)'), '08006'],
    [Object.assign(new Error('x'), { name: 'GoogleTokenError', status: 401 }), 'delegation_refused'],
    [Object.assign(new Error('x'), { name: 'GoogleTokenError', status: 403 }), 'delegation_refused'],
    [Object.assign(new Error('x'), { name: 'GoogleTokenError', status: 503 }), 'google-token_503'],
    [Object.assign(new Error('x'), { name: 'NoExclusionPolicyError' }), 'no_exclusion_policy'],
    [new DbError('registration lookup', 'PGRST301'), 'PGRST301'],
    [new Error('anything else'), 'unexpected'],
  ])('a throw records failed with a fixed code, and the throw stands (%s)', async (error, reason) => {
    const { db, events } = fakeDb();
    sync.impl = async (args) => {
      args.counts!.stored = 5;
      throw error;
    };
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).rejects.toBe(error);
    expect(events()[1].detail).toMatchObject({ status: 'failed', reason, stored: 5 });
  });

  it('builds the reader before loading the routing context, and skips an unsupported source without loading it (R2-M2)', async () => {
    const { db } = fakeDb();
    await handlersFor(db).sync(DATA);
    expect(sync.order).toEqual(['reader', 'context', `sync:${S1}`]);

    sync.order = [];
    access.guardedContentSource.mockImplementationOnce(() => {
      throw new UnsupportedSourceError('mailbox', 'microsoft', 'fixture', 'no reader');
    });
    await handlersFor(fakeDb().db).sync(DATA);
    expect(sync.order).toEqual([]);
  });

  it('retries the start once with the same passId, then reads', async () => {
    const { db, events } = fakeDb({ answers: [{ data: null, error: { code: '08006', message: '' } }] });
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toMatchObject({ status: 'complete' });
    const all = events();
    expect(all.map((e) => e.event)).toEqual(['started', 'started', 'finished']);
    expect(all[1].detail).toEqual(all[0].detail);
    expect(all[2].detail.passId).toBe(all[0].detail.passId);
  });

  it('reads nothing when the start fails twice', async () => {
    const failure = { data: null, error: { code: '42501', message: '' } };
    const { db, events } = fakeDb({ answers: [failure, failure] });
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).rejects.toThrow('reader pass start failed (42501)');
    expect(access.guardedContentSource).not.toHaveBeenCalled();
    expect(sync.order).toEqual([]);
    expect(events().map((e) => e.event)).toEqual(['started', 'started']);
  });

  it('a start answered with P0001 reader_pass_clock_skew twice fails the job with that code', async () => {
    const skew = { data: null, error: { code: 'P0001', message: 'reader_pass_clock_skew' } };
    const { db } = fakeDb({ answers: [skew, skew] });
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).rejects.toThrow('reader pass start failed (reader_pass_clock_skew)');
    expect(access.guardedContentSource).not.toHaveBeenCalled();
  });

  it('a start send that throws (a timeout) counts as a failed send, and is retried', async () => {
    const { db, events, rpc } = fakeDb();
    rpc.mockImplementationOnce(() => {
      const answer = Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      answer.catch(() => undefined);
      return Object.assign(answer, { abortSignal: () => answer }) as never;
    });
    await expect(handlersFor(db).sync(DATA)).resolves.toMatchObject({ status: 'complete' });
    expect(events().map((e) => e.event)).toEqual(['started', 'started', 'finished']);
  });

  it('bounds each send with an abort signal', async () => {
    vi.spyOn(AbortSignal, 'timeout');
    const { db, signals } = fakeDb();
    await handlersFor(db).sync(DATA);
    expect(signals).toHaveLength(2);
    expect(AbortSignal.timeout).toHaveBeenNthCalledWith(1, START_TIMEOUT_MS);
    expect(AbortSignal.timeout).toHaveBeenNthCalledWith(2, FINISH_TIMEOUT_MS);
  });

  it('keeps the original return when the end RPC errors or its send throws, and logs a code only', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const errored = fakeDb({ answers: [{ data: null, error: null }, { data: null, error: { code: '57014', message: 'canceling statement' } }] });
    await expect(handlersFor(errored.db).sync(DATA)).resolves.toEqual({ status: 'complete', pages: 1, fetched: 0, excluded: 0, stored: 2, screened: 0, flagged: 0 });
    expect(errorSpy).toHaveBeenLastCalledWith('discovery worker: reader pass end not recorded (57014)');

    const thrown = fakeDb();
    thrown.rpc.mockImplementationOnce(thrown.rpc.getMockImplementation()!).mockImplementationOnce(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    await expect(handlersFor(thrown.db).sync(DATA)).resolves.toEqual({ status: 'complete', pages: 1, fetched: 0, excluded: 0, stored: 2, screened: 0, flagged: 0 });
    expect(errorSpy).toHaveBeenLastCalledWith('discovery worker: reader pass end not recorded (unexpected)');
    for (const [line] of errorSpy.mock.calls) expect(String(line)).not.toMatch(/canceling|aborted/);
  });

  it('keeps the original throw when the end RPC also fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { db } = fakeDb({ answers: [{ data: null, error: null }, { data: null, error: { code: '08006', message: '' } }] });
    const error = new Error('discovery persist: source_items upsert failed (23P01)');
    sync.impl = async () => {
      throw error;
    };
    await expect(handlersFor(db).sync(DATA)).rejects.toBe(error);
  });

  it('still writes the end, with registration null, when the registration accessor throws (R2-m7)', async () => {
    const { db, events } = fakeDb();
    access.guardedContentSource.mockImplementation(() =>
      reader({
        registration: () => {
          throw new Error('boom');
        },
      }),
    );
    await handlersFor(db).sync(DATA, { jobId: JOB });
    expect(events()[1]).toMatchObject({ event: 'finished', detail: { status: 'complete', registration: null } });
  });

  it('normalizes the reader registration: a raw thumbprint lands lowercase and colon-free, a non-code clientId as null', async () => {
    const thumb = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01';
    const raw = fakeDb();
    access.guardedContentSource.mockImplementation(() => reader({ registration: () => ({ clientId: 'reader app@bank', certThumbprint: thumb }) }));
    await handlersFor(raw.db).sync(DATA);
    expect(raw.events()[1].detail.registration).toEqual({ clientId: null, certThumbprint: thumb.replaceAll(':', '').toLowerCase() });

    const google = fakeDb();
    access.guardedContentSource.mockImplementation(() => reader({ registration: () => ({ clientId: '123456789012345678', certThumbprint: null }) }));
    await handlersFor(google.db).sync(DATA);
    expect(google.events()[1].detail.registration).toEqual({ clientId: '123456789012345678', certThumbprint: null });
  });

  it('sends the counts syncSource reached, fetched and excluded included, when it throws', async () => {
    const { db, events } = fakeDb();
    sync.impl = async (args) => {
      Object.assign(args.counts!, { pages: 2, fetched: 6, excluded: 1, stored: 4, checkpointAdvanced: true });
      throw new Error('discovery persist: source_items upsert failed (23P01)');
    };
    await expect(handlersFor(db).sync(DATA)).rejects.toThrow('23P01');
    expect(events()[1].detail).toMatchObject({ status: 'failed', pages: 2, fetched: 6, excluded: 1, stored: 4, checkpointAdvanced: true });
  });

  it('sends a non-code reason as unexpected, and a non-uuid jobId as null', async () => {
    const { db, events } = fakeDb();
    access.guardedContentSource.mockImplementation(() => {
      throw new UnsupportedSourceError('mailbox', 'microsoft', 'fixture', 'no reader');
    });
    await handlersFor(db).sync(DATA, { jobId: 'not-a-uuid' });
    expect(events()[0].detail.jobId).toBeNull();

    const pass = await beginPass(db, { tenantId: TENANT, sourceId: S1, jobId: null }, { deployment: 'local', revision: null });
    await pass.finish({ status: 'failed', reason: 'Re: Project Falcon' });
    expect(events().at(-1)?.detail.reason).toBe('unexpected');
  });

  it('gives a pg-boss retry (same jobId) a new passId', async () => {
    const { db, events } = fakeDb();
    const handlers = handlersFor(db);
    await handlers.sync(DATA, { jobId: JOB });
    await handlers.sync(DATA, { jobId: JOB });
    const starts = events().filter((e) => e.event === 'started');
    expect(starts.map((e) => e.detail.jobId)).toEqual([JOB, JOB]);
    expect(starts[0].detail.passId).not.toBe(starts[1].detail.passId);
  });

  it('clamps endedAt to startedAt when the clock goes backwards, and finishes once only', async () => {
    const { db, events } = fakeDb();
    const times = [Date.parse('2026-10-06T12:00:00.000Z'), Date.parse('2026-10-06T11:59:00.000Z')];
    const pass = await beginPass(db, { tenantId: TENANT, sourceId: S1, jobId: null }, { deployment: 'local', revision: null }, {
      now: () => times.shift() ?? 0,
    });
    await pass.finish({ status: 'complete', reason: null });
    await pass.finish({ status: 'failed', reason: 'unexpected' });
    const ends = events().filter((e) => e.event === 'finished');
    expect(ends).toHaveLength(1);
    expect(ends[0].detail.endedAt).toBe('2026-10-06T12:00:00.000Z');
  });
});

describe('reader pass, classify-once (#370)', () => {
  const run = (db: SupabaseClient) => runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });

  it('flag off: a disabled / flag_off pass per active source, no provider read', async () => {
    flags.discovery = false;
    const { db, events } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }] });
    const summary = await run(db);
    expect(summary).toMatchObject({ status: 'skipped', reason: 'flag_disabled' });
    expect(pairs(events())).toEqual([
      ['started', null, null],
      ['started', null, null],
      ['finished', 'disabled', 'flag_off'],
      ['finished', 'disabled', 'flag_off'],
    ]);
    expect(access.readableMailboxes).not.toHaveBeenCalled();
  });

  it('no registration: skipped / no_provider per source', async () => {
    const { db, events } = fakeDb({ active: [] });
    await run(db);
    expect(pairs(events()).filter(([e]) => e === 'finished')).toEqual([['finished', 'skipped', 'no_provider']]);
  });

  it('providerPass throws: every pass failed with its code, and the throw propagates', async () => {
    access.readableMailboxes.mockImplementation(async () => {
      throw new Error('discovery sync: mailbox_allowlist read failed (PGRST301)');
    });
    const { db, events } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }] });
    await expect(run(db)).rejects.toThrow('PGRST301');
    expect(pairs(events()).filter(([e]) => e === 'finished')).toEqual([
      ['finished', 'failed', 'PGRST301'],
      ['finished', 'failed', 'PGRST301'],
    ]);
  });

  it('graph mode without a mirror refused: every pass failed, and the throw propagates', async () => {
    const { db, events } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }, { id: S3, provider: 'google' }] });
    await expect(runOnce({ tenantId: TENANT, db, provider: READER_MODE.GRAPH })).rejects.toThrow('graph mode replays a cassette');
    const ends = events().filter((e) => e.event === 'finished');
    expect(ends.map((e) => e.detail.status)).toEqual(['failed', 'failed']);
    expect(access.readableMailboxes).not.toHaveBeenCalled();
  });

  it('a tenant with no active sources makes no rpc call', async () => {
    const { db, rpc } = fakeDb({ sources: [] });
    await expect(run(db)).resolves.toMatchObject({ status: 'ok', sources: 0, passes: [] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('two sources: two passes sharing runId, an unregistered one refused registration_inactive; passes in the summary', async () => {
    const { db, events } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }, { id: S3, provider: 'google' }] });
    const summary = await run(db);
    if (summary.status !== 'ok') throw new Error('unreachable');
    const starts = events().filter((e) => e.event === 'started');
    expect(starts.map((e) => e.detail.runId)).toEqual([summary.runId, summary.runId]);
    expect(starts.map((e) => e.detail.jobId)).toEqual([null, null]);
    expect(starts[0].detail.passId).not.toBe(starts[1].detail.passId);
    expect(summary.passes).toEqual(starts.map((e) => ({ sourceId: e.detail.sourceId, passId: e.detail.passId })));
    const bySource = Object.fromEntries(events().filter((e) => e.event === 'finished').map((e) => [e.detail.sourceId, e.detail]));
    expect(bySource[S1]).toMatchObject({ status: 'complete', provider: 'microsoft', stored: 2 });
    expect(bySource[S3]).toMatchObject({ status: 'refused', reason: 'registration_inactive', provider: 'google', pages: 0 });
  });

  it('a skipped return (flag off, no registration) also lists its passes', async () => {
    const { db, events } = fakeDb({ active: [] });
    const summary = await run(db);
    expect(summary).toEqual({
      tenantId: TENANT,
      status: 'skipped',
      reason: 'no_active_registration',
      passes: [{ sourceId: S1, passId: events()[0].detail.passId }],
    });
  });

  it('the second of three sources throws: it ends failed with its code, the third skipped / run_aborted, the first as it ended (R2-m10)', async () => {
    const { db, events } = fakeDb({
      sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }, { id: S3, provider: 'microsoft' }],
    });
    sync.impl = async (args) => {
      if (args.source.id === S2) throw new Error('discovery persist: source_items upsert failed (23P01)');
      return { status: 'complete', mode: 'backfill', pages: 1, itemsRead: 0, storedKeys: new Set(), checkpointAdvanced: true };
    };
    await expect(run(db)).rejects.toThrow('23P01');
    const ends = Object.fromEntries(events().filter((e) => e.event === 'finished').map((e) => [e.detail.sourceId, e.detail]));
    expect(Object.keys(ends)).toHaveLength(3);
    expect(ends[S1]).toMatchObject({ status: 'complete', reason: null });
    expect(ends[S2]).toMatchObject({ status: 'failed', reason: '23P01' });
    expect(ends[S3]).toMatchObject({ status: 'skipped', reason: 'run_aborted' });
  });

  it('a start that cannot be written stops the run before any read, and ends the passes already started', async () => {
    const failure = { data: null, error: { code: '42501', message: '' } };
    const { db, events } = fakeDb({
      sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }],
      answers: [{ data: null, error: null }, failure, failure],
    });
    await expect(run(db)).rejects.toThrow('reader pass start failed (42501)');
    expect(access.readableMailboxes).not.toHaveBeenCalled();
    expect(pairs(events()).filter(([e]) => e === 'finished')).toEqual([['finished', 'failed', '42501']]);
  });

  it('loads the routing context once per run, after the first reader is built (R2-M2)', async () => {
    const { db } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }] });
    await run(db);
    expect(sync.order).toEqual(['reader', 'context', `sync:${S1}`, 'reader', `sync:${S2}`]);
  });
});

// #461: the tick deletes stored mail before it reads any. The backstop runs whatever the flags say; the group check
// runs per tenant and active provider whatever the sources' status, then the group-removal withdrawal.
// G-02b: the accept-expiry call (one call, every tenant) sits right after the backstop and before the flag gates, so
// the pinned order is: backstop, accept expiry, [flag gates], group checks, withdrawal, queue.
describe('the tick deletes stored mail before it queues a read (#461)', () => {
  const names = (rpc: ReturnType<typeof recordingRpc>['rpc']) => rpc.mock.calls.map(([name]) => name);
  const groupsChecked = () => access.readableMailboxes.mock.calls.map(([, tenant, provider]) => `${tenant}:${provider}`);
  const BOTH_REGISTRATIONS = ['graph_reader_registrations', 'google_reader_registrations'];

  it('runs the backstop with the flags off, and checks no group', async () => {
    flags.discovery = false;
    const { db, rpc } = fakeDb();
    await expect(handlersFor(db).tick()).resolves.toEqual({ queued: 0 });
    // The backstop, then the accept expiry: both run with the flags off, and nothing after them.
    expect(names(rpc)).toEqual(['discovery_collect_orphans_all', 'discovery_expire_model_proposal_accepts']);
    expect(access.readableMailboxes).not.toHaveBeenCalled();
  });

  it('with the flags on: the backstop, the accept expiry, each active provider\'s group, then the withdrawal, then the queue', async () => {
    const { db, rpc } = fakeDb({ active: BOTH_REGISTRATIONS });
    const boss = { send: vi.fn(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    expect(names(rpc)).toEqual([
      'discovery_collect_orphans_all',
      'discovery_expire_model_proposal_accepts',
      'discovery_withdraw_group_removed',
    ]);
    expect(groupsChecked()).toEqual([`${TENANT}:microsoft`, `${TENANT}:google`]);
    // The expiry is one call over every tenant, and it comes before the group checks (the first group read).
    expect(rpc.mock.calls[1][1]).toEqual({ p_tenant: null, p_max_age: '24 hours' });
    expect(rpc.mock.invocationCallOrder[1]).toBeLessThan(access.readableMailboxes.mock.invocationCallOrder[0]);
    expect(rpc.mock.invocationCallOrder[2]).toBeLessThan(boss.send.mock.invocationCallOrder[0]);
  });

  it('checks the group when every source is halted, or none is active (paused)', async () => {
    for (const sources of [[{ id: S1, provider: 'microsoft', lastError: 'history_window_exceeded' }], []] as SourceSpec[][]) {
      access.readableMailboxes.mockClear();
      const { db, rpc } = fakeDb({ sources });
      await expect(handlersFor(db).tick()).resolves.toEqual({ queued: 0 });
      expect(groupsChecked()).toEqual([`${TENANT}:microsoft`]);
      expect(names(rpc)).toContain('discovery_withdraw_group_removed');
    }
  });

  it('skips the live Microsoft group, which group removal does not cover (D93, D100), and checks Google', async () => {
    const { db } = fakeDb({ active: BOTH_REGISTRATIONS, sources: [] });
    const handlers = createWorkerHandlers({ db, boss: { send: vi.fn() }, provider: READER_MODE.LIVE });
    await expect(handlers.tick()).resolves.toEqual({ queued: 0 });
    expect(groupsChecked()).toEqual([`${TENANT}:google`]);
  });

  // The banker's own purge is synchronous, so reading does not depend on either step: a failure is one content-free
  // warn line naming what failed, and the tick goes on. The deletion is retried on the next tick.
  const warnings = () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return () => warn.mock.calls.map(([line]) => String(line));
  };

  it('a failed backstop is logged, and the tick still checks the groups, withdraws and queues', async () => {
    const lines = warnings();
    const { db, rpc } = fakeDb({ answers: [{ data: null, error: { code: '42501', message: 'denied for relation canary' } }] });
    const boss = { send: vi.fn(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    expect(lines()).toEqual(['{"evt":"orphan_collection_failed"}']);
    expect(names(rpc)).toEqual([
      'discovery_collect_orphans_all',
      'discovery_expire_model_proposal_accepts',
      'discovery_withdraw_group_removed',
    ]);
    expect(groupsChecked()).toEqual([`${TENANT}:microsoft`]);
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it('a failed group removal is logged, and the tick still queues', async () => {
    const lines = warnings();
    const { db } = fakeDb({ answers: [{ data: null, error: null }, { data: null, error: { code: 'XX000', message: 'boom canary' } }] });
    const boss = { send: vi.fn(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    expect(lines()).toEqual(['{"evt":"group_removal_failed"}']);
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it('passes the pilot breaker: every group-triggered withdrawal is held for the operator (owner, 2026-10-17)', async () => {
    expect(GROUP_REMOVAL_BREAKER_ACTIVE).toBe(GROUP_REMOVAL_BREAKER.pilot);
    expect(GROUP_REMOVAL_BREAKER.pilot).toEqual({ maxShare: 0, minDue: 1 });
    expect(GROUP_REMOVAL_BREAKER.general).toEqual({ maxShare: 0.3, minDue: 3 });
    const { db, rpc } = fakeDb();
    await handlersFor(db).tick();
    const call = rpc.mock.calls.find(([name]) => name === 'discovery_withdraw_group_removed');
    expect(call?.[1]).toEqual({ p_max_share: 0, p_min_due: 1 });
  });

  // A hold is the expected pilot state (D93): a notice naming the tenant id and the count, never the deletion-stuck
  // line. A hold left 24 hours past due is overdue, which the stuck alarm counts; so does a failure.
  const holding = (holds: unknown[]) =>
    fakeDb({ answers: [{ data: null, error: null }, { data: { withdrawn: 0, held: holds.length, holds }, error: null }] });
  const STUCK = ['orphan_collection_failed', 'group_removal_failed', 'group_removal_overdue'];
  const stuck = (lines: string[]) => lines.filter((line) => STUCK.includes(JSON.parse(line).evt));

  it('a held tenant is a notice with its id and count, not stuck, and the tick still queues', async () => {
    const lines = warnings();
    const { db } = holding([{ tenant: '11111111-1111-4111-8111-111111111111', due: 2, overdue: false }]);
    const boss = { send: vi.fn(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    expect(lines()).toEqual(['{"evt":"group_removal_held","tenant":"11111111-1111-4111-8111-111111111111","due":2}']);
    expect(stuck(lines())).toEqual([]);
  });

  it('a hold unreleased 24 hours past due is overdue, so it counts as stuck', async () => {
    const lines = warnings();
    const { db } = holding([{ tenant: '11111111-1111-4111-8111-111111111111', due: 1, overdue: true }]);
    await handlersFor(db).tick();
    expect(lines()).toEqual(['{"evt":"group_removal_overdue","tenant":"11111111-1111-4111-8111-111111111111","due":1}']);
    expect(stuck(lines())).toHaveLength(1);
  });

  it('a withdrawal stuck for another reason still counts as stuck, held or not', async () => {
    const lines = warnings();
    const { db } = fakeDb({
      answers: [{ data: null, error: { code: '57014', message: 'canceled canary' } }, { data: null, error: { code: 'XX000', message: 'boom canary' } }],
    });
    await handlersFor(db).tick();
    expect(stuck(lines())).toEqual(['{"evt":"orphan_collection_failed"}', '{"evt":"group_removal_failed"}']);
  });

  it('a throw from either step, not only an error answer, is caught the same way', async () => {
    const lines = warnings();
    const { db } = fakeDb();
    const rpc = vi.fn(() => Promise.reject(new Error('socket hang up canary')));
    (db as unknown as { rpc: unknown }).rpc = rpc;
    const boss = { send: vi.fn(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    // Every rpc throws: the backstop, the accept expiry and the withdrawal each log their own name, in tick order.
    expect(lines()).toEqual(['{"evt":"orphan_collection_failed"}', '{"evt":"accept_expiry_failed"}', '{"evt":"group_removal_failed"}']);
    expect(lines().join('')).not.toContain('canary');
  });

  it('with the flags off, a failed backstop is logged and the tick queues nothing', async () => {
    flags.discovery = false;
    const lines = warnings();
    const { db } = fakeDb({ answers: [{ data: null, error: { code: '42501', message: 'denied' } }] });
    await expect(handlersFor(db).tick()).resolves.toEqual({ queued: 0 });
    expect(lines()).toEqual(['{"evt":"orphan_collection_failed"}']);
  });
});

// Reader liveness: a source handleExpiry halted (history_window_exceeded) waits for the firm admin's restart; the
// worker neither queues nor reads it.
describe('a halted source (history_window_exceeded) is not read', () => {
  const HALTED = 'history_window_exceeded';
  const BOTH: SourceSpec[] = [
    { id: S1, provider: 'microsoft', lastError: HALTED },
    { id: S2, provider: 'microsoft' },
  ];

  it('the tick queues the unhalted source only', async () => {
    const { db } = fakeDb({ sources: BOTH });
    const boss = { send: vi.fn<(queue: string, data: { sourceId: string }, options?: unknown) => Promise<string>>(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    expect(boss.send.mock.calls.map(([, data]) => data.sourceId)).toEqual([S2]);
  });

  it('a sync job for a halted source skips with source_halted and reads nothing', async () => {
    const { db, events } = fakeDb({ sources: [BOTH[0]] });
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toEqual({ status: 'skipped', skipReason: 'source_halted' });
    expect(pairs(events())).toEqual([
      ['started', null, null],
      ['finished', 'skipped', 'source_halted'],
    ]);
    expect(access.guardedContentSource).not.toHaveBeenCalled();
    expect(sync.order).toEqual([]);
  });

  it('keeps the skip order: disabled, then no_provider, then source_halted', async () => {
    flags.discovery = false;
    const disabled = fakeDb({ sources: [BOTH[0]] });
    await expect(handlersFor(disabled.db).sync(DATA)).resolves.toEqual({ status: 'disabled' });
    expect(pairs(disabled.events())[1]).toEqual(['finished', 'disabled', 'flag_off']);

    flags.discovery = true;
    const noProvider = fakeDb({ active: [], sources: [BOTH[0]] });
    await expect(handlersFor(noProvider.db).sync(DATA)).resolves.toEqual({ status: 'skipped', skipReason: 'no_provider' });
    expect(pairs(noProvider.events())[1]).toEqual(['finished', 'skipped', 'no_provider']);
  });

  it('a halted source with an inactive registration records source_halted, not a refusal', async () => {
    const { db, events } = fakeDb({ active: ['google_reader_registrations'], sources: [BOTH[0]] });
    await expect(handlersFor(db).sync(DATA)).resolves.toEqual({ status: 'skipped', skipReason: 'source_halted' });
    expect(pairs(events())[1]).toEqual(['finished', 'skipped', 'source_halted']);
  });

  it('runOnce records passes for, and reads, the unhalted source only', async () => {
    const { db, events } = fakeDb({ sources: BOTH });
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.sources).toBe(1);
    expect(summary.passes.map((p) => p.sourceId)).toEqual([S2]);
    expect(events().map((e) => e.detail.sourceId)).toEqual([S2, S2]);
    expect(sync.order).toEqual(['reader', 'context', `sync:${S2}`]);
  });

  it('runOnce re-checks the halt before reading: a source that halts after the run named it is not read', async () => {
    const s1: SourceSpec = { id: S1, provider: 'microsoft' };
    const { db, from, events } = fakeDb({ sources: [s1, { id: S2, provider: 'microsoft' }] });
    // The first content_sources read is activeSources(): S1 is unhalted then, and halts right after (another job).
    const base = from.getMockImplementation()!;
    let reads = 0;
    from.mockImplementation((table: string) => {
      const builder = base(table);
      if (table === 'content_sources' && ++reads === 1) s1.lastError = HALTED;
      return builder;
    });
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.passes.map((p) => p.sourceId)).toEqual([S1, S2]);
    expect(summary.skipped).toEqual([{ sourceId: S1, kind: 'mailbox', reason: 'source_halted' }]);
    const s1Ends = events().filter((e) => e.event === 'finished' && e.detail.sourceId === S1);
    expect(s1Ends.map((e) => [e.detail.status, e.detail.reason])).toEqual([['skipped', 'source_halted']]);
    expect(sync.order).toEqual(['reader', 'context', `sync:${S2}`]);
  });
});

// Reader liveness: the sync job hands its reader the source's progress mark, which writes reader_progress_at.
describe('the reader gets the source\'s progress mark', () => {
  it('a sync job builds the reader with onProgress, and calling it marks this source', async () => {
    const { db, updates } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }] });
    await handlersFor(db).sync(DATA, { jobId: JOB });
    expect(access.guardedContentSource).toHaveBeenCalledTimes(1);
    const ctx = access.guardedContentSource.mock.calls[0][2] as { onProgress?: () => void };
    expect(ctx.onProgress).toBeTypeOf('function');
    ctx.onProgress!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const marks = updates.filter((u) => u.table === 'content_sources' && 'reader_progress_at' in u.patch);
    expect(marks).toHaveLength(1);
    expect(marks[0].filters).toEqual([
      ['id', S1],
      ['tenant_id', TENANT],
    ]);
  });
});

// m1: every pass of a runOnce starts at the run start, whatever the clock reads while the starts are sent.
describe('reader pass, classify-once totals (R1)', () => {
  it('adds a source refused mid-read to the run totals, as its pass end records it', async () => {
    const { db, events } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }] });
    sync.impl = async (args) => {
      if (args.source.id === S2) {
        Object.assign(args.counts!, { pages: 1, fetched: 4, excluded: 2, stored: 1, checkpointAdvanced: true });
        throw new MailboxAccessRefusedError(TENANT, 'b@bank.example', 'no_consent', 'provider_read');
      }
      Object.assign(args.counts!, { pages: 1, fetched: 3, excluded: 0, stored: 2, checkpointAdvanced: true });
      return { status: 'complete', mode: 'backfill', pages: 1, itemsRead: 3, storedKeys: new Set(['a', 'b']), checkpointAdvanced: true, fetched: 3, excluded: 0 };
    };
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.refused).toEqual([{ sourceId: S2, reason: 'no_consent' }]);
    const ends = events().filter((e) => e.event === 'finished');
    const sum = (key: 'fetched' | 'excluded') => ends.reduce((total, e) => total + (e.detail[key] as number), 0);
    expect(summary).toMatchObject({ fetched: 7, excluded: 2 });
    expect([summary.fetched, summary.excluded]).toEqual([sum('fetched'), sum('excluded')]);
  });
});

describe('reader pass, classify-once routing totals (#460 A1)', () => {
  it('counts what a source refused mid-read had read, so the four routing counts still add up to read', async () => {
    const { db } = fakeDb({ sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }] });
    const { emptyRoutingTally } = await vi.importActual<typeof import('../../worker/sync')>('../../worker/sync');
    sync.impl = async (args) => {
      if (args.source.id === S2) {
        Object.assign(args.read!, { itemsRead: 4 });
        Object.assign(args.read!.routing, { routed: 1, unrouted: 2, skipped: 1, collisions: 0 });
        args.read!.routing.codenameKeys.add('osprey');
        throw new MailboxAccessRefusedError(TENANT, 'b@bank.example', 'no_consent', 'provider_read');
      }
      const routing = { ...emptyRoutingTally(), routed: 2, unrouted: 1, codenameKeys: new Set(['falcon']) };
      return { status: 'complete', mode: 'backfill', pages: 1, itemsRead: 3, storedKeys: new Set(['a', 'b']), checkpointAdvanced: true, fetched: 3, excluded: 0, routing };
    };
    const summary = await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error('unreachable');
    expect(summary.refused).toEqual([{ sourceId: S2, reason: 'no_consent' }]);
    expect(summary.itemsRead).toBe(7);
    expect(summary.routing).toMatchObject({ read: 7, routed: 3, unrouted: 3, skipped: 1, collisions: 0, codenames: 2 });
    const r = summary.routing;
    expect(r.routed + r.unrouted + r.skipped + r.collisions).toBe(r.read);
  });
});

describe('reader pass, classify-once start time (#370 m1)', () => {
  it('gives every source the same startedAt, the run start, while each end keeps its own clock', async () => {
    let tick = Date.parse('2026-10-06T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1_000));
    const { db, events } = fakeDb({
      sources: [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }, { id: S3, provider: 'microsoft' }],
    });
    await runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
    const starts = events().filter((e) => e.event === 'started').map((e) => e.detail.startedAt);
    expect(starts).toHaveLength(3);
    expect(new Set(starts).size).toBe(1);
    const ends = events().filter((e) => e.event === 'finished');
    for (const end of ends) expect(end.detail.startedAt).toBe(starts[0]);
    expect(new Set(ends.map((e) => e.detail.endedAt)).size).toBe(3);
    for (const end of ends) expect(Date.parse(end.detail.endedAt as string)).toBeGreaterThan(Date.parse(starts[0] as string));
  });
});

// m2: runOnce starts a pass for every active source before any tenant-level check, so whichever check stops the run,
// every source has its start first.
describe('reader pass, classify-once starts before every tenant-level check (#370 m2)', () => {
  const SOURCES: SourceSpec[] = [{ id: S1, provider: 'microsoft' }, { id: S2, provider: 'microsoft' }];
  const run = (db: SupabaseClient) => runOnce({ tenantId: TENANT, db, provider: READER_MODE.FIXTURE });
  /** Every source's start is in the trace before the first occurrence of `step`, which must occur. */
  const startedBefore = (step: string) => {
    const at = trace.indexOf(step);
    expect(at, `${step} in ${trace.join(' > ')}`).toBeGreaterThanOrEqual(0);
    for (const source of SOURCES) {
      const started = trace.indexOf(`started:${source.id}`);
      expect(started, `started:${source.id} in ${trace.join(' > ')}`).toBeGreaterThanOrEqual(0);
      expect(started, `started:${source.id} before ${step}`).toBeLessThan(at);
    }
  };

  it('discoveryEnabled reports off', async () => {
    flags.discovery = false;
    const { db } = fakeDb({ sources: SOURCES });
    await run(db);
    startedBefore('flag');
  });

  it('discoveryEnabled throws', async () => {
    flags.throws = new Error('flag lookup failed (08006)');
    const { db, events } = fakeDb({ sources: SOURCES });
    await expect(run(db)).rejects.toThrow('08006');
    startedBefore('flag');
    expect(pairs(events()).filter(([e]) => e === 'finished')).toEqual(SOURCES.map(() => ['finished', 'failed', '08006']));
  });

  it('activeProviders reports none', async () => {
    const { db } = fakeDb({ sources: SOURCES, active: [] });
    await run(db);
    startedBefore('from:graph_reader_registrations');
  });

  it('activeProviders throws', async () => {
    const { db, events } = fakeDb({ sources: SOURCES, failTable: 'graph_reader_registrations' });
    await expect(run(db)).rejects.toThrow('registration lookup failed (PGRST301)');
    startedBefore('from:graph_reader_registrations');
    expect(pairs(events()).filter(([e]) => e === 'finished')).toEqual(SOURCES.map(() => ['finished', 'failed', 'PGRST301']));
  });

  it('loadRoutingContext throws', async () => {
    sync.contextThrows = new Error('discovery sync: source_items read failed (57014)');
    const { db, events } = fakeDb({ sources: SOURCES });
    await expect(run(db)).rejects.toThrow('57014');
    startedBefore('context');
    const ends = Object.fromEntries(events().filter((e) => e.event === 'finished').map((e) => [e.detail.sourceId, e.detail]));
    expect(ends[S1]).toMatchObject({ status: 'failed', reason: '57014' });
    expect(ends[S2]).toMatchObject({ status: 'skipped', reason: 'run_aborted' });
  });
});

// m3: the worker sends exactly the key sets discovery_reader_pass_valid() accepts. An extra or missing key would be
// refused at runtime (22023), and the pass would silently read "No end recorded".
describe('reader pass detail keys match the writer (#370 m3)', () => {
  /** The two key lists of discovery_reader_pass_valid(), in the order the migration states them: started, finished. */
  function sqlKeyLists(): string[][] {
    const sql = readFileSync('supabase/migrations/20261006120000_discovery_reader_pass.sql', 'utf8');
    const lists = [...sql.matchAll(/v_keys is distinct from array\[([^\]]+)\]/g)].map((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((k) => k[1]),
    );
    expect(lists).toHaveLength(2);
    return lists;
  }

  it('sends the started and finished details with exactly the keys the SQL checks', async () => {
    const [startedKeys, finishedKeys] = sqlKeyLists();
    const { db, events } = fakeDb();
    await handlersFor(db).sync(DATA, { jobId: JOB });
    const [start, end] = events();
    expect(Object.keys(start.detail).sort()).toEqual([...startedKeys].sort());
    expect(Object.keys(end.detail).sort()).toEqual([...finishedKeys].sort());
    expect(Object.keys(start.detail.worker as object).sort()).toEqual(['deployment', 'revision']);
  });

  it('sends the same key set for a failed attempt and for a runOnce pass', async () => {
    const [, finishedKeys] = sqlKeyLists();
    const failing = fakeDb();
    sync.impl = async () => {
      throw new Error('boom');
    };
    await expect(handlersFor(failing.db).sync(DATA)).rejects.toThrow('boom');
    expect(Object.keys(failing.events()[1].detail).sort()).toEqual([...finishedKeys].sort());

    sync.impl = null;
    flags.discovery = false;
    const once = fakeDb();
    await runOnce({ tenantId: TENANT, db: once.db, provider: READER_MODE.FIXTURE });
    expect(Object.keys(once.events()[1].detail).sort()).toEqual([...finishedKeys].sort());
  });
});

describe('reader pass, provider attachment', () => {
  it('names the source provider on the end of a Google pass', async () => {
    const { db, events } = fakeDb({ active: ['google_reader_registrations'], sources: [{ id: S3, provider: MAILBOX_PROVIDER.GOOGLE }] });
    await handlersFor(db).sync({ tenantId: TENANT, sourceId: S3 });
    expect(events()[1].detail).toMatchObject({ provider: 'google', status: 'complete' });
  });
});
