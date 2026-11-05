// The discovery workers' job queue (design Q2): pg-boss, version pinned in
// package.json, in the `pgboss` schema that
// supabase/migrations/20260925140000_pgboss_schema.sql creates from pg-boss's
// own construction plan. The worker never migrates it (migrate: false,
// createSchema: false), so its database role needs no DDL, and a pg-boss
// upgrade is a reviewed migration generated from the new version's plan.
//
// The options below keep pg-boss to DML at run time as well: no persisted
// queue statistics (their daily partitions are DDL), no index rebuilds, and
// no partitioned queues (a partitioned queue is a new table).
//
// Connection: the Supabase session pooler (IPv4), never the transaction
// pooler, whose behavior under pg-boss's advisory locks and LISTEN is not
// established. Domain writes go through the supabase-js service client; this
// connection carries the queue only, so it logs in as the discovery_queue
// role (20260925160000_discovery_queue_role.sql): DML on pgboss, nothing in
// public, and no way to alter or disable a trigger. In production the worker
// refuses to fall back to DATABASE_URL, which is the table owner.

import { PgBoss } from 'pg-boss';

import { isProductionAppEnv } from '@/lib/appEnv';

export const PGBOSS_SCHEMA = 'pgboss';

export const QUEUE = {
  /** Scheduled: enqueues a sync for every active, unhalted source of every active registration. */
  TICK: 'discovery.tick',
  /** One content source: reads pages from its checkpoint, routes and stores them. */
  SYNC: 'discovery.sync',
  /** One tenant: clusters its stored items into candidates. */
  DISCOVER: 'discovery.discover',
  CENSUS: 'discovery.census',
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Every few minutes; each source's own job decides how much there is to read. */
export const TICK_CRON = '*/5 * * * *';
export const CENSUS_CRON = '0 2 * * 1';

export type SyncJobData = { tenantId: string; sourceId: string };
export type DiscoverJobData = { tenantId: string };

/**
 * Queue policies. `stately` allows one queued and one active job per
 * singleton key: a source is never synced twice at once (its checkpoint has a
 * single writer), a long backfill can queue its own continuation, and the
 * tick cannot pile jobs up behind a slow one.
 */
export const QUEUE_OPTIONS = {
  [QUEUE.TICK]: { policy: 'singleton', retryLimit: 0, expireInSeconds: 300 },
  [QUEUE.SYNC]: {
    policy: 'stately',
    retryLimit: 8,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 3600,
    // A live handler refreshes heartbeat_on every 60 s; pg-boss's supervisor fails (and retries) a job whose process
    // died, freeing the source's stately slot in about 2 to 3 minutes instead of the hour-long expiry (C6). Jobs
    // created before this option reached the queue carry no heartbeat and keep the expiry.
    heartbeatSeconds: 120,
  },
  [QUEUE.DISCOVER]: { policy: 'stately', retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 1800 },
  [QUEUE.CENSUS]: { policy: 'singleton', retryLimit: 2, retryDelay: 300, expireInSeconds: 1800 },
} as const;

export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const queueUrl = env.DISCOVERY_QUEUE_DATABASE_URL?.trim();
  if (!queueUrl && isProductionAppEnv(env)) {
    throw new Error(
      'The discovery worker needs DISCOVERY_QUEUE_DATABASE_URL in production: the session pooler as the discovery_queue role, never the table owner',
    );
  }
  const url = queueUrl || env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'The discovery worker needs DISCOVERY_QUEUE_DATABASE_URL (or DATABASE_URL): the Supabase session pooler connection string',
    );
  }
  return url;
}

export function createBoss(connectionString: string, options: { schedule?: boolean; supervise?: boolean } = {}): PgBoss {
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: 'conductia-discovery-worker',
    migrate: false,
    createSchema: false,
    schedule: options.schedule ?? true,
    supervise: options.supervise ?? true,
    reindex: false,
    persistQueueStats: false,
    max: 4,
  });
}

/** Creates the three queues if missing: rows in pgboss.queue, no DDL (none is partitioned). */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const [name, options] of Object.entries(QUEUE_OPTIONS)) {
    await boss.createQueue(name, { ...options, partition: false });
    // create_queue is INSERT ... ON CONFLICT DO NOTHING: an existing queue keeps its old options. updateQueue is a
    // plain UPDATE of pgboss.queue, within discovery_queue's DML grant.
    if ('heartbeatSeconds' in options) await boss.updateQueue(name, { heartbeatSeconds: options.heartbeatSeconds });
  }
}
