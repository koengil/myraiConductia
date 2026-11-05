// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The worker's environment (#344, design R18).
//   - serviceClientFromEnv, which the classify service and classify-once both
//     build their client with, refuses the legacy JWT service_role key in
//     production: deleting a secret key (kill-switch lever 3) would not revoke it.
//   - The queue URL is read once, by createBoss, and leaves process.env as soon
//     as the boss is built. SUPABASE_SECRET_KEY stays: the guard reads it on
//     every call.
// The local-stack case (opt-in, RUN_DB_TESTS=1, local DATABASE_URL only) shows
// that pg-boss still works after the scrub.

const fakeBoss = vi.hoisted(() => ({ calls: [] as unknown[][], queueUpdates: [] as unknown[][], active: false }));
vi.mock('../../worker/boss', async () => {
  const actual = await vi.importActual<typeof import('../../worker/boss')>('../../worker/boss');
  return {
    ...actual,
    createBoss: (...args: Parameters<typeof actual.createBoss>) => {
      if (!fakeBoss.active) return actual.createBoss(...args);
      fakeBoss.calls.push(args);
      return {
        on: () => undefined,
        start: async () => undefined,
        createQueue: async () => undefined,
        updateQueue: async (...update: unknown[]) => {
          fakeBoss.queueUpdates.push(update);
        },
        schedule: async () => undefined,
        work: async () => 'worker',
        stop: async () => undefined,
      } as never;
    },
  };
});

import { WorkerSecretKeyShapeError } from '@/lib/supabase/secretKeyShape';
import { requireLocalDatabase } from '../db/localDatabase';
import { QUEUE } from '../../worker/boss';
import { serviceClientFromEnv, startWorkerFromEnv } from '../../worker/classify';

// Built from fragments so no key-shaped literal sits in the repo.
const JWT_SHAPED = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'canary-signature'].join('.');
const SECRET_KEY = ['sb', 'secret', 'canary0123456789'].join('_');
const LOCAL_URL = 'http://127.0.0.1:1';
const QUEUE_URL = 'postgresql://discovery_queue.ref:canary-password@127.0.0.1:1/postgres';
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllEnvs();
  fakeBoss.active = false;
  fakeBoss.calls = [];
  fakeBoss.queueUpdates = [];
});

describe('serviceClientFromEnv calls the key-shape helper (R18)', () => {
  it('refuses a JWT-shaped key in production, naming the variable and never the value', () => {
    let thrown: unknown;
    try {
      serviceClientFromEnv(env({ NEXT_PUBLIC_APP_ENV: 'prod', NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SECRET_KEY: JWT_SHAPED }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkerSecretKeyShapeError);
    expect((thrown as Error).message).toContain('SUPABASE_SECRET_KEY');
    expect((thrown as Error).message).not.toContain('canary');
  });

  it('builds the client from an sb_secret_ key in production, and from the local JWT key outside it', () => {
    expect(() =>
      serviceClientFromEnv(env({ NEXT_PUBLIC_APP_ENV: 'prod', NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SECRET_KEY: SECRET_KEY })),
    ).not.toThrow();
    expect(() => serviceClientFromEnv(env({ NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SECRET_KEY: JWT_SHAPED }))).not.toThrow();
  });

  // Both entries the image runs through classify.mjs: the service (--serve) and classify-once.
  it.each([[['--serve']], [['--tenant', randomUUID()]]])(
    'the %j entry refuses the legacy key before any connection, with one fatal line',
    async (argv) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts', ...argv], {
        cwd: process.cwd(),
        // A minimal environment: nothing of the parent's reaches the child. Nothing listens on port 1.
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          NEXT_PUBLIC_APP_ENV: 'prod',
          NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL,
          SUPABASE_SECRET_KEY: JWT_SHAPED,
          DISCOVERY_QUEUE_DATABASE_URL: QUEUE_URL,
          DISCOVERY_READER_MODE: 'live',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
      expect(code, err).toBe(1);
      expect(out.trim().split('\n').map((line) => JSON.parse(line))).toEqual([{ evt: 'fatal', reason: 'WorkerSecretKeyShapeError' }]);
      expect(out + err).not.toContain('canary');
    },
    60_000,
  );
});

describe('the queue URL leaves the environment once the boss is built (R18)', () => {
  it('startWorkerFromEnv hands the URL to createBoss, then deletes it from process.env; the secret key stays', async () => {
    fakeBoss.active = true;
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'dev');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', LOCAL_URL);
    vi.stubEnv('SUPABASE_SECRET_KEY', 'local-test-key');
    vi.stubEnv('DISCOVERY_QUEUE_DATABASE_URL', QUEUE_URL);
    vi.stubEnv('DISCOVERY_READER_MODE', 'fixture');

    await startWorkerFromEnv();

    expect(fakeBoss.calls).toHaveLength(1);
    expect(fakeBoss.calls[0][0]).toBe(QUEUE_URL);
    // ensureQueues gives an existing sync queue the heartbeat (create_queue keeps an existing queue's options).
    expect(fakeBoss.queueUpdates).toEqual([[QUEUE.SYNC, { heartbeatSeconds: 120 }]]);
    expect('DISCOVERY_QUEUE_DATABASE_URL' in process.env).toBe(false);
    expect(process.env.SUPABASE_SECRET_KEY).toBe('local-test-key');
  });

  it('keeps the URL when the start fails, so nothing is half-scrubbed before an exit', async () => {
    const start = env({ NEXT_PUBLIC_SUPABASE_URL: LOCAL_URL, SUPABASE_SECRET_KEY: 'k', DISCOVERY_QUEUE_DATABASE_URL: QUEUE_URL });
    fakeBoss.active = true;
    // No DISCOVERY_READER_MODE: the start refuses before the boss is built.
    await expect(startWorkerFromEnv(start)).rejects.toThrow(/DISCOVERY_READER_MODE/);
    expect(fakeBoss.calls).toHaveLength(0);
    expect(start.DISCOVERY_QUEUE_DATABASE_URL).toBe(QUEUE_URL);
  });
});

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN_DB_TESTS)('the scrubbed worker still runs jobs (local stack)', () => {
  it('pg-boss completes a job after the queue URL is gone from the environment', async () => {
    // Local only: the database guard refuses any non-local DATABASE_URL, and the REST URL must be loopback too.
    requireLocalDatabase();
    const restUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    expect(['127.0.0.1', 'localhost']).toContain(new URL(restUrl).hostname);
    const local = env({
      NEXT_PUBLIC_SUPABASE_URL: restUrl,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY ?? '',
      DISCOVERY_QUEUE_DATABASE_URL: process.env.DATABASE_URL ?? '',
      DISCOVERY_READER_MODE: 'fixture',
    });

    const worker = await startWorkerFromEnv(local, { schedule: false });
    try {
      expect('DISCOVERY_QUEUE_DATABASE_URL' in local).toBe(false);
      // A tenant with nothing stored: the discover job clusters nothing and completes.
      const tenantId = randomUUID();
      const id = await worker.boss.send(QUEUE.DISCOVER, { tenantId }, { singletonKey: tenantId });
      expect(id).toBeTruthy();
      const deadline = Date.now() + 30_000;
      let state: string | undefined;
      while (Date.now() < deadline) {
        state = (await worker.boss.getJobById(QUEUE.DISCOVER, id!))?.state;
        if (state === 'completed' || state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(state).toBe('completed');
    } finally {
      await worker.stop();
    }
  }, 60_000);
});
