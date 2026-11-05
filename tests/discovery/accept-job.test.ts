// @vitest-environment node
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The accept step as the SYNC job wires it (G-02b #173, design R4): when it runs, with which token and lease, and that
// its read goes through the same guarded path as every read without ever claiming a first read. acceptStep itself is
// tested in accept-step.test.ts; here it is a spy, and syncSource is a stub that records how it was called.
const access = vi.hoisted(() => ({
  assertSourceAllowed: vi.fn(),
  readableMailboxes: vi.fn(),
  guardedContentSource: vi.fn(),
  createGuardedContentSource: vi.fn(),
}));
vi.mock('@/lib/mailboxAccess', async () => {
  const actual = await vi.importActual<typeof import('@/lib/mailboxAccess')>('@/lib/mailboxAccess');
  return {
    ...actual,
    assertSourceAllowed: access.assertSourceAllowed,
    readableMailboxes: access.readableMailboxes,
    guardedContentSource: access.guardedContentSource,
    createGuardedContentSource: access.createGuardedContentSource,
    createFixtureAllowlistMirror: () => ({ listMembers: async () => [] }),
    createLiveAllowlistMirror: () => ({ listMembers: async () => [] }),
  };
});
const flags = vi.hoisted(() => ({ on: new Set<string>() }));
vi.mock('@/lib/flags/isEnabled', () => ({ isEnabled: async (key: string) => flags.on.has(key) }));
vi.mock('@/lib/discovery/sendCensus/load', () => ({ loadDealContacts: vi.fn(async () => undefined) }));

type SyncArgs = Parameters<typeof import('../../worker/sync').syncSource>[1];
const sync = vi.hoisted(() => ({
  calls: [] as SyncArgs[],
  /** Called with the 0-based call number; a throw is the read's failure. */
  onCall: null as null | ((n: number, args: SyncArgs) => void),
}));
vi.mock('../../worker/sync', async () => {
  const actual = await vi.importActual<typeof import('../../worker/sync')>('../../worker/sync');
  return {
    ...actual,
    loadRoutingContext: async () => new actual.RoutingContext(),
    discoverTenant: async () => [],
    syncSource: async (_db: unknown, args: SyncArgs) => {
      const n = sync.calls.push(args) - 1;
      sync.onCall?.(n, args);
      const result = {
        status: 'complete',
        mode: 'backfill',
        pages: 1,
        itemsRead: 0,
        storedKeys: new Set<string>(),
        checkpointAdvanced: false,
        fetched: 0,
        excluded: 0,
        unchanged: 0,
        screening: { screened: 0, flagged: 0 },
        routing: actual.emptyRoutingTally(),
        fullRead: false,
      };
      return args.accept ? { ...result, accepted: actual.emptyAcceptBuffer() } : result;
    },
  };
});
const step = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock('../../worker/accept', async () => {
  const actual = await vi.importActual<typeof import('../../worker/accept')>('../../worker/accept');
  return { ...actual, acceptStep: step.spy };
});

import { READER_MODE } from '@/lib/constants/discovery';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess';
import { createWorkerHandlers } from '../../worker/classify';
import { recordingRpc, type RpcAnswer } from '../helpers/readerPassRpc';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const DATA = { tenantId: TENANT, sourceId: SOURCE };
const DEMO = 'discovery_model_proposals_demo';

/** A fake service client: one active source of the provider, its registration, the flags table, and a recording rpc. */
function fakeDb(provider: 'microsoft' | 'google' = 'google') {
  const registration = provider === 'google' ? 'google_reader_registrations' : 'graph_reader_registrations';
  const recorder = recordingRpc();
  const from = vi.fn((table: string) => {
    let rows: unknown[] = [];
    if (table === 'content_sources') {
      rows = [
        {
          id: SOURCE,
          tenant_id: TENANT,
          kind: 'mailbox',
          provider,
          address: 'storm.duncan@bank.example',
          owner_user_id: '55555555-5555-4555-8555-555555555555',
          delta_checkpoint: null,
          last_error: null,
        },
      ];
    } else if (table === 'feature_flags') {
      rows = [{ enabled: true }];
    } else if (table === registration) {
      rows = [{ tenant_id: TENANT }];
    }
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      not: () => builder,
      order: () => builder,
      limit: () => builder,
      range: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return builder;
  });
  return { db: { from, rpc: recorder.rpc } as unknown as SupabaseClient, rpc: recorder.rpc, events: recorder.events };
}

const handlersFor = (db: SupabaseClient, boss: { send: (...args: unknown[]) => Promise<string | null> } = { send: vi.fn(async () => 'job') }) =>
  createWorkerHandlers({
    db,
    boss,
    provider: READER_MODE.FIXTURE,
    // The inner reader is never iterated: syncSource is a stub. The guard wrapper is the mocked door.
    readerFor: () => ({ kind: 'mailbox', backfill: async function* () {}, delta: async function* () {} }),
  });

beforeEach(() => {
  flags.on = new Set(['deal_discovery', DEMO]);
  sync.calls = [];
  sync.onCall = null;
  step.spy.mockReset();
  step.spy.mockResolvedValue({ claimed: 0, finished: 0 });
  access.assertSourceAllowed.mockReset();
  access.assertSourceAllowed.mockResolvedValue(undefined);
  access.readableMailboxes.mockReset();
  access.readableMailboxes.mockImplementation(async () => ({
    status: 'in_sync',
    readable: new Set<string>(),
    missingInGroup: [],
    extraInGroup: [],
    providerCheck: () => null,
  }));
  access.createGuardedContentSource.mockReset();
  access.createGuardedContentSource.mockImplementation((inner: unknown) => inner);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('when the accept step runs', () => {
  it('after the normal pass, with the attempt\'s pass id as its token and a 75 minute lease', async () => {
    const { db, events } = fakeDb();
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toMatchObject({ status: 'complete' });
    expect(sync.calls).toHaveLength(1);
    expect(step.spy).toHaveBeenCalledTimes(1);
    const deps = step.spy.mock.calls[0][0];
    expect(deps).toMatchObject({ token: events()[0].detail.passId, lease: '75 minutes', pageBudget: 200 });
    expect(deps.token).not.toBe(JOB);
    expect(deps.source).toMatchObject({ id: SOURCE, tenantId: TENANT });
    expect(deps.runId).toBe(events()[0].detail.passId);
    expect(typeof deps.read).toBe('function');
    expect(typeof deps.admitted).toBe('function');
    expect(typeof deps.onRequestError).toBe('function');
  });

  it('with a pass id as its token when the job has no id', async () => {
    const { db, events } = fakeDb();
    await handlersFor(db).sync(DATA);
    expect(step.spy.mock.calls[0][0].token).toBe(events()[0].detail.passId);
  });

  it('a token per attempt: two attempts of the same job id (a pg-boss retry) never share one', async () => {
    const { db } = fakeDb();
    const handlers = handlersFor(db);
    await handlers.sync(DATA, { jobId: JOB });
    await handlers.sync(DATA, { jobId: JOB });
    expect(step.spy).toHaveBeenCalledTimes(2);
    const [first, second] = step.spy.mock.calls.map(([deps]) => deps.token as string);
    expect(first).toEqual(expect.any(String));
    expect(second).toEqual(expect.any(String));
    expect(first).not.toBe(second);
  });

  it('a request that failed is logged by its id and a code, and the pass result stands', async () => {
    const { db } = fakeDb();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const request = '66666666-6666-4666-8666-666666666666';
    step.spy.mockImplementation(async (deps: { onRequestError: (id: string, error: unknown) => void }) => {
      deps.onRequestError(request, new Error('discovery sync: accept discovery_mark_model_proposal_accept_storing failed (22023)'));
      return { claimed: 2, finished: 1 };
    });
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toMatchObject({ status: 'complete' });
    const lines = output.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('"evt":"accept"'));
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { evt: 'accept', tenant: TENANT, source: SOURCE, request, status: 'failed', reason: 'Database error' },
      { evt: 'accept', tenant: TENANT, source: SOURCE, claimed: 2, finished: 1 },
    ]);
    expect(lines.join('')).not.toContain('22023');
  });

  it('not while the demo flag is off', async () => {
    flags.on.delete(DEMO);
    const { db } = fakeDb();
    await handlersFor(db).sync(DATA, { jobId: JOB });
    expect(step.spy).not.toHaveBeenCalled();
  });

  it('not while deal_discovery is off: the job reads nothing', async () => {
    flags.on.delete('deal_discovery');
    const { db } = fakeDb();
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toEqual({ status: 'disabled' });
    expect(step.spy).not.toHaveBeenCalled();
    expect(sync.calls).toHaveLength(0);
  });

  it('not once pg-boss has aborted the job', async () => {
    const { db } = fakeDb();
    const controller = new AbortController();
    sync.onCall = () => controller.abort();
    await handlersFor(db).sync(DATA, { jobId: JOB, signal: controller.signal });
    expect(step.spy).not.toHaveBeenCalled();
  });

  it('a normal pass the guard refused still runs it, so the requests end now', async () => {
    const { db } = fakeDb();
    sync.onCall = () => {
      throw new MailboxAccessRefusedError(TENANT, 'storm.duncan@bank.example', 'no_consent', 'provider_read');
    };
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toMatchObject({ status: 'refused', reason: 'no_consent' });
    expect(step.spy).toHaveBeenCalledTimes(1);
  });

  it('never fails the job: a failed step logs ids and a code, and the pass result stands', async () => {
    const { db } = fakeDb();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    step.spy.mockRejectedValue(new Error('discovery sync: accept discovery_claim_model_proposal_accepts failed (57014)'));
    await expect(handlersFor(db).sync(DATA, { jobId: JOB })).resolves.toMatchObject({ status: 'complete' });
    const lines = output.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('"evt":"accept"'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ evt: 'accept', tenant: TENANT, source: SOURCE, status: 'failed', reason: 'Database error' });
  });

  it('logs the counts of a step that claimed something, and nothing for one that claimed nothing', async () => {
    const { db } = fakeDb();
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await handlersFor(db).sync(DATA, { jobId: JOB });
    expect(output.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('"evt":"accept"'))).toEqual([]);

    step.spy.mockResolvedValue({ claimed: 2, finished: 1 });
    await handlersFor(db).sync(DATA, { jobId: JOB });
    const lines = output.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes('"evt":"accept"'));
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ evt: 'accept', tenant: TENANT, source: SOURCE, claimed: 2, finished: 1 }]);
  });
});

describe('the accept read goes through the guarded path and claims no first read (R4)', () => {
  it('the normal Gmail pass is handed a first-read claim; the accept read is not', async () => {
    const { db } = fakeDb('google');
    step.spy.mockImplementation(async (deps: { read: (accept: unknown) => Promise<unknown> }) => {
      const out = await deps.read({ keys: new Map(), pageBudget: 3 });
      expect(out).toMatchObject({ status: 'read' });
      return { claimed: 1, finished: 1 };
    });

    await handlersFor(db).sync(DATA, { jobId: JOB });

    // Two reads, each behind its own guarded reader (createGuardedContentSource wraps every reader, an override too).
    expect(sync.calls).toHaveLength(2);
    expect(access.createGuardedContentSource).toHaveBeenCalledTimes(2);
    const [normal, accepted] = access.createGuardedContentSource.mock.calls.map(([, ctx]) => ctx);
    expect(typeof normal.claimFirstRead).toBe('function');
    expect(accepted.claimFirstRead).toBeUndefined();
    // The accept read is an accept read of a copy: it is handed the accept option and a pass count of its own.
    expect(sync.calls[0].accept).toBeUndefined();
    expect(sync.calls[1].accept).toMatchObject({ pageBudget: 3 });
    expect(sync.calls[1].counts).not.toBe(sync.calls[0].counts);
  });

  it('a refused or skipped accept read is reported to the step as unavailable', async () => {
    const { db } = fakeDb('google');
    let answer: unknown;
    step.spy.mockImplementation(async (deps: { read: (accept: unknown) => Promise<unknown> }) => {
      sync.onCall = () => {
        throw new MailboxAccessRefusedError(TENANT, 'storm.duncan@bank.example', 'no_consent', 'provider_read');
      };
      answer = await deps.read({ keys: new Map(), pageBudget: 3 });
      return { claimed: 1, finished: 1 };
    });
    await handlersFor(db).sync(DATA, { jobId: JOB });
    expect(answer).toEqual({ status: 'unavailable' });
  });

  it('the first-read claim is withheld from an accept in the source, not only by the caller passing reread', () => {
    const classify = readFileSync('worker/classify.ts', 'utf8');
    const read = classify.slice(classify.indexOf('async function readOneSource('), classify.indexOf('async function discoveryEnabled('));
    expect(read).toMatch(/!a\.reread && a\.propose === undefined && a\.accept === undefined\s*\?\s*\{ claimFirstRead: firstReadClaim/);
  });
});

describe('the guard re-check of a stored resume (no read of its own)', () => {
  /** What the step's `admitted` answers for this job. */
  async function admittedFor(setup: () => void = () => undefined): Promise<boolean | undefined> {
    const { db } = fakeDb('google');
    setup();
    let admitted: boolean | undefined;
    step.spy.mockImplementation(async (deps: { admitted: () => Promise<boolean> }) => {
      admitted = await deps.admitted();
      return { claimed: 1, finished: 1 };
    });
    await handlersFor(db).sync(DATA, { jobId: JOB });
    return admitted;
  }

  it('asks the mailbox guard with the provider read purpose, the source and its owner, and admits what it allows', async () => {
    expect(await admittedFor()).toBe(true);
    expect(access.assertSourceAllowed).toHaveBeenCalledWith(
      TENANT,
      { kind: 'mailbox', address: 'storm.duncan@bank.example', ownerUserId: '55555555-5555-4555-8555-555555555555' },
      expect.objectContaining({ purpose: 'provider_read', caller: 'discovery-worker', provider: 'google', providerReason: null }),
    );
    // The re-check is not a read.
    expect(sync.calls).toHaveLength(1);
  });

  it('refuses what the guard refuses', async () => {
    expect(
      await admittedFor(() =>
        access.assertSourceAllowed.mockRejectedValue(
          new MailboxAccessRefusedError(TENANT, 'storm.duncan@bank.example', 'no_consent', 'provider_read'),
        ),
      ),
    ).toBe(false);
  });

  it('refuses when the provider group does not hold the address, whatever the guard says', async () => {
    expect(
      await admittedFor(() =>
        access.readableMailboxes.mockImplementation(async () => ({
          status: 'in_sync',
          readable: new Set<string>(),
          missingInGroup: [],
          extraInGroup: [],
          providerCheck: () => 'not_in_provider_group',
        })),
      ),
    ).toBe(false);
    expect(access.assertSourceAllowed).toHaveBeenCalledWith(
      TENANT,
      expect.anything(),
      expect.objectContaining({ providerReason: 'not_in_provider_group' }),
    );
  });

  it('fails closed when the provider check is not usable', async () => {
    expect(
      await admittedFor(() =>
        access.readableMailboxes.mockImplementation(async () => ({
          status: 'in_sync',
          readable: new Set<string>(),
          missingInGroup: [],
          extraInGroup: [],
          providerCheck: () => true,
        })),
      ),
    ).toBe(false);
    expect(access.assertSourceAllowed).toHaveBeenCalledWith(
      TENANT,
      expect.anything(),
      expect.objectContaining({ providerReason: 'mirror_unavailable' }),
    );
  });
});

describe('the tick ends accept requests no job will finish (design R4)', () => {
  const expiries = (rpc: ReturnType<typeof fakeDb>['rpc']) => rpc.mock.calls.filter(([name]) => name === 'discovery_expire_model_proposal_accepts');

  it('once for every tenant (p_tenant null), with a 24 hour age, before it queues a sync', async () => {
    const { db, rpc } = fakeDb('microsoft');
    const boss = { send: vi.fn(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    expect(expiries(rpc).map(([, args]) => args)).toEqual([{ p_tenant: null, p_max_age: '24 hours' }]);
    const at = rpc.mock.calls.findIndex(([name]) => name === 'discovery_expire_model_proposal_accepts');
    expect(rpc.mock.invocationCallOrder[at]).toBeLessThan(boss.send.mock.invocationCallOrder[0]);
  });

  it('even with the demo flag off: it is deletion housekeeping, and the database takes no lock when nothing is due', async () => {
    flags.on.delete(DEMO);
    const { db, rpc } = fakeDb('microsoft');
    await expect(handlersFor(db).tick()).resolves.toEqual({ queued: 1 });
    expect(expiries(rpc).map(([, args]) => args)).toEqual([{ p_tenant: null, p_max_age: '24 hours' }]);
  });

  it('even when reads are off (before the registration lookup, so tenants without one are covered too)', async () => {
    flags.on.clear();
    const { db, rpc } = fakeDb('microsoft');
    await expect(handlersFor(db).tick()).resolves.toEqual({ queued: 0 });
    expect(expiries(rpc).map(([, args]) => args)).toEqual([{ p_tenant: null, p_max_age: '24 hours' }]);
  });

  it('a failed expiry is logged by name only, and the tick still queues', async () => {
    const { db, rpc } = fakeDb('microsoft');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = rpc.getMockImplementation()!;
    rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name !== 'discovery_expire_model_proposal_accepts') return original(name, args);
      const failed = Promise.resolve<RpcAnswer>({ data: null, error: { code: '57014', message: 'canceling statement' } });
      return Object.assign(failed, { abortSignal: () => failed });
    });
    const boss = { send: vi.fn(async () => 'job') };
    await expect(handlersFor(db, boss).tick()).resolves.toEqual({ queued: 1 });
    expect(boss.send).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{ evt: 'accept_expiry_failed' }]);
  });
});
