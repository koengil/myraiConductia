// @vitest-environment node
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serializeError } from 'serialize-error';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The worker's job log and pg-boss failure output (#344, design R12 and R13).
// pg-boss 12 stores a thrown handler error in pgboss.job.output through
// serialize-error (name, message, stack and own properties) for 7 days, and the
// worker used to print raw error text. A canary planted in a failure must reach
// neither the value thrown to pg-boss nor stdout nor stderr, and every line
// carries ids, codes and counts only.

const fakeBoss = vi.hoisted(() => ({ current: null as null | ReturnType<typeof makeFakeBoss> }));
function makeFakeBoss() {
  const emitter = new EventEmitter();
  const workers = new Map<string, (jobs: Array<{ data: unknown }>) => Promise<unknown>>();
  const queueUpdates: unknown[][] = [];
  return {
    emitter,
    workers,
    queueUpdates,
    boss: {
      on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
      start: async () => undefined,
      createQueue: async () => undefined,
      updateQueue: async (...update: unknown[]) => {
        queueUpdates.push(update);
      },
      schedule: async () => undefined,
      send: async () => 'job',
      stop: async () => undefined,
      work: async (name: string, optionsOrHandler: unknown, maybeHandler?: unknown) => {
        const handler = (typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler) as (
          jobs: Array<{ data: unknown }>,
        ) => Promise<unknown>;
        workers.set(name, handler);
        return name;
      },
    },
  };
}
vi.mock('../../worker/boss', async () => {
  const actual = await vi.importActual<typeof import('../../worker/boss')>('../../worker/boss');
  return {
    ...actual,
    createBoss: (...args: Parameters<typeof actual.createBoss>) =>
      fakeBoss.current ? (fakeBoss.current.boss as never) : actual.createBoss(...args),
  };
});

import { READER_MODE } from '@/lib/constants/discovery';
import { QUEUE } from '../../worker/boss';
import { SERVE_REFUSAL, serveRefusal, startWorker } from '../../worker/classify';
import { failureReason, logEvent, runJob, WorkerJobError } from '../../worker/jobLog';
import { SYNC_ERROR } from '../../worker/sync';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const CANARY = 'canary-falcon-7f3a';
const ADDRESS = `${CANARY}@buyer.example`;

/** A PostgREST-shaped failure as persist.ts throws it, the canary in every field. */
function postgrestError(): Error {
  return Object.assign(
    new Error(`discovery persist: source_items insert failed: Key (internet_message_id)=(<${ADDRESS}>) already exists`),
    { code: '23505', details: `Key (internet_message_id)=(<${ADDRESS}>)`, hint: CANARY },
  );
}

let stdout: string[];
let stderr: string[];
let warnings: string[];
beforeEach(() => {
  stdout = [];
  stderr = [];
  warnings = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => (stderr.push(String(chunk)), true));
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stdout.push(args.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.map(String).join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  fakeBoss.current = null;
});

const lines = () => stdout.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const printed = () => stdout.join('') + stderr.join('');

it('sanitizes census contact lookup failure lines', () => {
  logEvent({ evt: 'census_contacts', tenant: ADDRESS, status: 'failed', reason: `lookup failed for ${ADDRESS}` });
  expect(lines()).toEqual([{ evt: 'census_contacts', tenant: 'invalid', status: 'failed', reason: 'invalid' }]);
  expect(printed()).not.toContain(CANARY);
});

it('sanitizes a tenant census refresh failure line', () => {
  logEvent({ evt: 'census', tenant: ADDRESS, status: 'failed', reason: `refresh failed for ${ADDRESS}` });
  expect(lines()).toEqual([{ evt: 'census', tenant: 'invalid', status: 'failed', reason: 'invalid' }]);
  expect(printed()).not.toContain(CANARY);
});

describe('a failed job leaves only its fixed code (R13)', () => {
  it('rethrows WorkerJobError(code): the canary reaches neither the thrown value, stdout nor stderr', async () => {
    const thrown = await runJob('sync', { tenant: TENANT, source: SOURCE }, async () => {
      throw postgrestError();
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(WorkerJobError);
    expect(thrown).toMatchObject({ name: 'WorkerJobError', message: SYNC_ERROR.DATABASE });
    expect((thrown as Error).cause).toBeUndefined();
    // What pg-boss stores: serialize-error over the thrown value, as manager.js does.
    const stored = JSON.stringify(serializeError(thrown));
    expect(JSON.parse(stored)).toMatchObject({ name: 'WorkerJobError', message: 'Database error' });
    for (const text of [stored, printed()]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain('buyer.example');
    }
    expect(lines()).toEqual([{ evt: 'sync', tenant: TENANT, source: SOURCE, status: 'failed', reason: 'Database error' }]);
  });

  it('keeps the Google and Graph codes errorSummary gives the admin, never their messages', async () => {
    class GoogleHttpError extends Error {
      constructor(readonly status: number, readonly reason: string | null) {
        super(`Google request failed: ${status} (body: ${CANARY})`);
        this.name = 'GoogleHttpError';
      }
    }
    const thrown = await runJob('sync', { tenant: TENANT, source: SOURCE }, async () => {
      throw new GoogleHttpError(403, 'rateLimitExceeded');
    }).catch((error: unknown) => error);
    expect(thrown).toMatchObject({ name: 'WorkerJobError', message: 'Google 403 rateLimitExceeded' });
    expect(JSON.stringify(serializeError(thrown))).not.toContain(CANARY);
    expect(printed()).not.toContain(CANARY);
  });

  it('a failed tick or discover prints its code the same way', async () => {
    await expect(runJob('tick', {}, async () => Promise.reject(postgrestError()))).rejects.toBeInstanceOf(WorkerJobError);
    await expect(runJob('discover', { tenant: TENANT }, async () => Promise.reject(new Error(CANARY)))).rejects.toMatchObject({
      message: SYNC_ERROR.WORKER,
    });
    expect(lines()).toEqual([
      { evt: 'tick', status: 'failed', reason: 'Database error' },
      { evt: 'discover', tenant: TENANT, status: 'failed', reason: 'Worker error' },
    ]);
    expect(printed()).not.toContain(CANARY);
  });
});

describe('the job lines carry ids, codes and counts only (R12, A7)', () => {
  it('a success line names the job ids and the counts, and the result goes back to pg-boss unchanged', async () => {
    const result = { status: 'complete', pages: 2, fetched: 1, excluded: 1, stored: 1 };
    await expect(runJob('sync', { tenant: TENANT, source: SOURCE }, async () => result)).resolves.toBe(result);
    expect(lines()).toEqual([{ evt: 'sync', tenant: TENANT, source: SOURCE, status: 'complete', pages: 2, fetched: 1, excluded: 1, stored: 1 }]);
  });

  it('a refusal line carries its reason code; a skip carries its skip reason', async () => {
    await runJob('sync', { tenant: TENANT, source: SOURCE }, async () => ({ status: 'refused', reason: 'no_consent' }));
    await runJob('sync', { tenant: TENANT, source: SOURCE }, async () => ({ status: 'skipped', skipReason: 'unsupported_reader' }));
    await runJob('tick', {}, async () => ({ queued: 3 }));
    await runJob('discover', { tenant: TENANT }, async () => ({ candidates: 2 }));
    expect(lines()).toEqual([
      { evt: 'sync', tenant: TENANT, source: SOURCE, status: 'refused', reason: 'no_consent' },
      { evt: 'sync', tenant: TENANT, source: SOURCE, status: 'skipped', reason: 'unsupported_reader' },
      { evt: 'tick', queued: 3 },
      { evt: 'discover', tenant: TENANT, candidates: 2 },
    ]);
  });

  it('never emits an address: extra result fields are dropped, and address-shaped ids or codes become `invalid`', async () => {
    await runJob('sync', { tenant: ADDRESS, source: `${SOURCE}\n${ADDRESS}` }, async () => ({
      status: ADDRESS,
      reason: `refused for ${ADDRESS}`,
      pages: 1,
      address: ADDRESS,
      subject: CANARY,
    }));
    expect(lines()).toEqual([{ evt: 'sync', tenant: 'invalid', source: 'invalid', status: 'invalid', pages: 1, reason: 'invalid' }]);
    expect(printed()).not.toContain('@');
    expect(printed()).not.toContain(CANARY);
  });

  it('writes one JSON object per line', () => {
    logEvent({ evt: 'tick', queued: 0 });
    logEvent({ evt: 'queue_error', reason: 'Worker error' });
    expect(stdout.join('')).toBe('{"evt":"tick","queued":0}\n{"evt":"queue_error","reason":"Worker error"}\n');
  });
});

/** A fake service client whose every read fails with the canary in its PostgREST message. */
function failingDb(): SupabaseClient {
  const failure = { data: null, error: { message: `relation leak ${ADDRESS}`, details: CANARY, hint: CANARY, code: 'XX000' } };
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'not', 'order', 'range']) builder[method] = () => builder;
  builder.maybeSingle = async () => failure;
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(failure).then(resolve);
  return { from: () => builder, rpc: async () => failure } as unknown as SupabaseClient;
}

describe('startWorker routes every job and the queue error handler through the code-only log', () => {
  it('the four boss.work callbacks log codes and counts only', async () => {
    fakeBoss.current = makeFakeBoss();
    await startWorker({ db: failingDb(), connectionString: 'postgresql://unused', provider: READER_MODE.FIXTURE, schedule: false });
    const { workers, queueUpdates } = fakeBoss.current;
    expect([...workers.keys()].sort()).toEqual([QUEUE.CENSUS, QUEUE.DISCOVER, QUEUE.SYNC, QUEUE.TICK].sort());
    // ensureQueues gives an existing sync queue the heartbeat before any worker starts.
    expect(queueUpdates).toEqual([[QUEUE.SYNC, { heartbeatSeconds: 120 }]]);

    // The tick runs the backstop first (#461), then the accept expiry (G-02b), both before the flags. On this database
    // each fails: that is one warn line naming the step, no id and no error text, and the tick goes on. The flag read
    // fails closed (reads are off), so nothing is queued, and the tick succeeds.
    const tick = await workers.get(QUEUE.TICK)!([]).catch((error: unknown) => error);
    expect(tick).toEqual({ queued: 0 });
    expect(warnings.filter((line) => line.startsWith('{'))).toEqual([
      '{"evt":"orphan_collection_failed"}',
      '{"evt":"accept_expiry_failed"}',
    ]);
    await expect(workers.get(QUEUE.CENSUS)!([])).resolves.toEqual({ tenants: 0, rows: 0, failed: 0, unattributed: 0 });
    const discover = await workers.get(QUEUE.DISCOVER)!([{ data: { tenantId: TENANT } }]).catch((error: unknown) => error);
    expect(discover).toMatchObject({ name: 'WorkerJobError', message: SYNC_ERROR.DATABASE });
    expect(JSON.stringify(serializeError(discover))).not.toContain(CANARY);
    // The sync job writes its reader pass start first (#370), before any flag read. On this database the start
    // cannot be written, so the job fails closed with a fixed code and reads nothing.
    const sync = await workers.get(QUEUE.SYNC)!([{ data: { tenantId: TENANT, sourceId: SOURCE } }]).catch((error: unknown) => error);
    expect(sync).toMatchObject({ name: 'WorkerJobError', message: SYNC_ERROR.WORKER });
    expect(JSON.stringify(serializeError(sync))).not.toContain(CANARY);

    expect(lines()).toEqual([
      { evt: 'tick', queued: 0 },
      { evt: 'census', tenants: 0, rows: 0, failed: 0, unattributed: 0 },
      { evt: 'discover', tenant: TENANT, status: 'failed', reason: 'Database error' },
      { evt: 'sync', tenant: TENANT, source: SOURCE, status: 'failed', reason: 'Worker error' },
    ]);
    expect(printed()).not.toContain(CANARY);
    expect(warnings.join('')).not.toContain(CANARY);
  });

  it('the sync callback hands pg-boss\'s job id to the handler, so the reader pass records it (#370)', async () => {
    fakeBoss.current = makeFakeBoss();
    const worker = await startWorker({ db: failingDb(), connectionString: 'postgresql://unused', provider: READER_MODE.FIXTURE, schedule: false });
    const sync = vi.spyOn(worker.handlers, 'sync').mockResolvedValue({ status: 'disabled' });
    const JOB = '44444444-4444-4444-8444-444444444444';
    const data = { tenantId: TENANT, sourceId: SOURCE };
    const callback = fakeBoss.current.workers.get(QUEUE.SYNC)! as (jobs: Array<{ id: string; data: unknown }>) => Promise<unknown>;
    await expect(callback([{ id: JOB, data }])).resolves.toEqual({ status: 'disabled' });
    expect(sync).toHaveBeenCalledWith(data, { jobId: JOB });
  });

  it("the boss 'error' handler prints a code, never the pg message", async () => {
    fakeBoss.current = makeFakeBoss();
    await startWorker({ db: failingDb(), connectionString: 'postgresql://unused', provider: READER_MODE.FIXTURE, schedule: false });
    class DatabaseError extends Error {
      override name = 'DatabaseError';
    }
    fakeBoss.current.emitter.emit('error', Object.assign(new DatabaseError(`invalid input syntax: "${ADDRESS}"`), { detail: CANARY }));
    fakeBoss.current.emitter.emit('error', new Error(`connection to ${ADDRESS} lost`));
    expect(lines()).toEqual([
      { evt: 'queue_error', reason: 'DatabaseError' },
      { evt: 'queue_error', reason: 'Worker error' },
    ]);
    expect(printed()).not.toContain(CANARY);
    expect(printed()).not.toContain('@');
  });

  it('failureReason prints a class name only when it is a plain identifier', () => {
    const odd = new Error(CANARY);
    odd.name = `Weird ${ADDRESS}`;
    expect(failureReason(odd)).toBe('Worker error');
    expect(failureReason('a thrown string')).toBe('Worker error');
    expect(failureReason(postgrestError())).toBe('Database error');
  });
});

describe('the top-level catch prints a code, never the message (R12)', () => {
  let server: Server;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('a PostgREST error carrying the canary exits 1 with one fatal line and no canary', async () => {
    // A local stand-in for PostgREST that refuses every request with the canary in its body.
    server = createServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'PGRST100', message: `bad filter ${ADDRESS}`, details: CANARY, hint: CANARY }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    vi.restoreAllMocks();
    // classify-once with no --tenant reads the registrations first; the stand-in refuses that read.
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts'], {
      cwd: process.cwd(),
      // A minimal environment: nothing of the parent's (no hosted credential can reach the child).
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SECRET_KEY: 'local-test-key',
        DISCOVERY_READER_MODE: 'fixture',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code, err).toBe(1);
    expect(out.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ evt: 'fatal', reason: 'Worker error' }]);
    expect(err).toBe('');
    expect(out + err).not.toContain(CANARY);
  }, 60_000);
});

// Demo-only (#460): the model gateway key belongs to the one-off classify-propose task alone
// (infra/discovery-worker/ecs.tf). The service refuses to start with it rather than quietly hold it next to
// the mailbox credentials.
describe('--serve refuses to start with the model gateway key present (#460)', () => {
  it('serveRefusal names the key by its presence alone, never its value', () => {
    expect(serveRefusal({})).toBeNull();
    expect(serveRefusal({ DISCOVERY_PROPOSE_TRANSPORT: 'gateway' })).toBeNull();
    expect(serveRefusal({ AI_GATEWAY_API_KEY: CANARY })).toBe(SERVE_REFUSAL.GATEWAY_KEY_PRESENT);
    expect(serveRefusal({ AI_GATEWAY_API_KEY: '' })).toBe('gateway_key_present');
  });

  let server: Server;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('exits 1 with exactly one fatal line carrying the code, before it builds a client or opens the queue', async () => {
    // One local listener stands in for both PostgREST and the queue database, and counts every connection.
    let connections = 0;
    server = createServer((_req, res) => res.end('{}'));
    server.on('connection', () => (connections += 1));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    vi.restoreAllMocks();
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--serve'], {
      cwd: process.cwd(),
      // A minimal environment: nothing of the parent's (no hosted credential can reach the child).
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
        SUPABASE_SECRET_KEY: 'local-test-key',
        DISCOVERY_QUEUE_DATABASE_URL: `postgresql://worker:unused@127.0.0.1:${port}/postgres`,
        DISCOVERY_READER_MODE: 'fixture',
        AI_GATEWAY_API_KEY: `${CANARY}-gateway-key`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code, err).toBe(1);
    expect(out.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ evt: 'fatal', reason: 'gateway_key_present' }]);
    expect(err).toBe('');
    expect(out + err).not.toContain(CANARY);
    expect(connections).toBe(0);
  }, 60_000);
});
