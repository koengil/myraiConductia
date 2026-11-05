import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/*
 * The reader pass record (#370) against a REAL database, with the fixture reader standing in for the provider:
 *
 *   1. One discovery.sync job leaves exactly two pass rows, chained, whose passId is the runId of every ledger row
 *      the job wrote.
 *   2. A real guard refusal (the owner withdraws while a page is in flight) ends refused / no_consent with the page
 *      it read and its checkpoint.
 *   3. discovery_worker_enabled turned off between pages ends the pass paused / flag_off.
 *   4. A checkpoint write the database refuses ends the pass failed / P0001, with the page's items counted as
 *      stored and no page counted.
 *   5. runOnce over two sources records two passes sharing the run id, and lists them in its summary.
 *   6. A pass that never finishes (the crash case) leaves its start only.
 *
 * Each case uses its own throwaway tenant, set up the way the #262 allowlist admits a mailbox.
 */

import { verifyChain, type AuditChainRow } from '@/lib/audit/chain';
import { READER_MODE } from '@/lib/constants/discovery';
import type { ContentSource } from '@/lib/graph/reader';
import { FIXTURE_PAGE_SIZE } from '@/lib/graph/reader/fixture';
import { createWorkerHandlers, runOnce } from '../../worker/classify';
import { beginPass, workerIdentity } from '../../worker/passRecord';
import { innerFixtureReader } from '../discovery/fixtureInnerReader';
import {
  createGuardedTenant,
  dropGuardedTenant,
  enableDiscoveryFlag,
  optInOwners,
  registerFixtureReader,
  type GuardedTenant,
  type GuardedTenantEnv,
} from './support/guardedTenant';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret || !publishable) {
  throw new Error(
    'The reader pass test needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack).',
  );
}
const databaseUrl = process.env.DATABASE_URL;
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const env: GuardedTenantEnv = { db, url, publishableKey: publishable, run: RUN, password: `Pass-${RUN}-x9!` };
const ALEX = 'alex.chen@bank.example';
const MORGAN = 'morgan.vale@bank.example';
const STORM = 'storm.duncan@bank.example';

type PassRow = { action: string; ts: string; chain_seq: number; detail: Record<string, unknown> };

const tenants: GuardedTenant[] = [];
let restoreDiscovery: () => Promise<void> = async () => undefined;
let previousWorkerFlag: { enabled: boolean } | null = null;

async function setWorkerFlag(enabled: boolean) {
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: 'discovery_worker_enabled', description: 'discovery worker (integration)', enabled }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
}

beforeAll(async () => {
  restoreDiscovery = await enableDiscoveryFlag(db);
  const { data } = await db.from('feature_flags').select('enabled').eq('key', 'discovery_worker_enabled').maybeSingle();
  previousWorkerFlag = data as { enabled: boolean } | null;
  await setWorkerFlag(true);
});

afterAll(async () => {
  for (const tenant of tenants) {
    await db.from('content_sources').delete().eq('tenant_id', tenant.id);
    await dropGuardedTenant(env, tenant);
  }
  if (previousWorkerFlag) await setWorkerFlag(previousWorkerFlag.enabled);
  else await db.from('feature_flags').delete().eq('key', 'discovery_worker_enabled');
  await restoreDiscovery();
});

/** A tenant whose owners opted in, with the fixture registration; returns the source id by address. */
async function tenantWith(label: string, mailboxes: string[]) {
  const tenant = await createGuardedTenant(env, label, mailboxes);
  tenants.push(tenant);
  await registerFixtureReader(env, tenant);
  await optInOwners(tenant);
  const { data, error } = await db.from('content_sources').select('id, address').eq('tenant_id', tenant.id);
  if (error) throw new Error(`content sources failed: ${error.message}`);
  const sourceIds = new Map((data ?? []).map((row) => [row.address as string, row.id as string]));
  return { tenant, sourceIds };
}

async function passRows(tenantId: string): Promise<PassRow[]> {
  const { data, error } = await db
    .from('audit_log')
    .select('action, ts, chain_seq, detail')
    .eq('tenant_id', tenantId)
    .like('action', 'discovery.reader_pass_%')
    .order('chain_seq');
  if (error) throw new Error(`audit read failed: ${error.message}`);
  return (data ?? []) as PassRow[];
}

const ends = (rows: PassRow[]) => rows.filter((row) => row.action === 'discovery.reader_pass_finished');

/** The tenant's whole chain, read by psql so detail keeps Postgres's own text (the hash covers it). */
function chainOf(tenantId: string): AuditChainRow[] {
  const sql = `select coalesce(json_agg(json_build_object(
    'id', id, 'ts', ts, 'tenant_id', tenant_id, 'chain_seq', chain_seq::text,
    'actor_type', actor_type, 'actor_id', actor_id, 'service_identity', service_identity,
    'action', action, 'deal_id', deal_id, 'document_id', document_id,
    'detail_text', detail::text, 'prev_hash', encode(prev_hash, 'hex'), 'hash', encode(hash, 'hex')) order by chain_seq), '[]'::json)
    from audit_log where tenant_id = '${tenantId}'`;
  const out = execFileSync('psql', [databaseUrl!, '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' });
  return JSON.parse(out.trim()) as AuditChainRow[];
}

function psql(sql: string): void {
  execFileSync('psql', [databaseUrl!, '-X', '-v', 'ON_ERROR_STOP=1', '-qc', sql], { encoding: 'utf8', stdio: 'pipe' });
}

const noBoss = () => ({ send: async () => 'job' }) as never;

describe('one discovery.sync job', () => {
  it('leaves exactly two chained pass rows, joined to the ledger rows it wrote by runId', async () => {
    const { tenant, sourceIds } = await tenantWith('job', [STORM]);
    const sourceId = sourceIds.get(STORM)!;
    const jobId = crypto.randomUUID();
    const handlers = createWorkerHandlers({ db, boss: noBoss(), provider: READER_MODE.FIXTURE });
    const result = await handlers.sync({ tenantId: tenant.id, sourceId }, { jobId });
    expect(result).toMatchObject({ status: 'complete' });

    const rows = await passRows(tenant.id);
    expect(rows.map((row) => row.action)).toEqual(['discovery.reader_pass_started', 'discovery.reader_pass_finished']);
    const [start, end] = rows;
    expect(start.detail).toMatchObject({ jobId, sourceId, worker: { deployment: 'local', revision: null } });
    expect(start.detail.runId).toBe(start.detail.passId);
    expect(end.detail).toMatchObject({
      passId: start.detail.passId,
      runId: start.detail.runId,
      jobId,
      provider: 'microsoft',
      registration: null,
      status: 'complete',
      reason: null,
      checkpointAdvanced: true,
    });
    expect(end.detail.pages).toBeGreaterThanOrEqual(1);
    expect(end.detail.stored).toBeGreaterThan(0);

    const { data: ledger } = await db.from('routing_ledger').select('run_id').eq('source_id', sourceId);
    expect(ledger?.length).toBeGreaterThan(0);
    expect(new Set((ledger ?? []).map((row) => row.run_id))).toEqual(new Set([start.detail.passId]));
    // Every fixture message read was ledgered once, and each crossed the wire (#370 phase 2).
    expect(end.detail.fetched).toBe(ledger?.length);
    expect(end.detail.excluded).toBe(0);
    // The job line (#344 G2) carries the same counts as the pass record.
    expect(result).toEqual({
      status: 'complete',
      pages: end.detail.pages,
      fetched: end.detail.fetched,
      excluded: 0,
      stored: end.detail.stored,
      // Incoming-mail screening (plan v5 W3): every message read is screened, and the fixture mail is ordinary.
      screened: end.detail.fetched,
      flagged: 0,
      // A first read: nothing was processed before (#461's skip rule).
      unchanged: 0,
    });

    if (databaseUrl) expect(verifyChain(chainOf(tenant.id))).toMatchObject({ ok: true });
  });
});

describe('a guard refusal mid-backfill', () => {
  // A withdrawal now deletes the source with its mail (#461; discovery-resume covers a withdrawal in flight), so
  // the refusal here is a pause: the source stays, and the guard refuses it source_paused before the next page.
  it('ends refused / source_paused with the page it read and its checkpoint', async () => {
    const { tenant, sourceIds } = await tenantWith('refuse', [MORGAN]);
    const fixture = innerFixtureReader();
    let paused = false;
    const reader: ContentSource = {
      kind: fixture.kind,
      backfill: (source, checkpoint) => ({
        async *[Symbol.asyncIterator]() {
          for await (const page of fixture.backfill(source, checkpoint)) {
            if (!paused) {
              paused = true;
              const { error } = await db.from('content_sources').update({ status: 'paused' }).eq('id', source.id);
              if (error) throw new Error(`pause failed: ${error.message}`);
            }
            yield page;
          }
        },
      }),
      delta: (source, token) => fixture.delta(source, token),
    };
    const handlers = createWorkerHandlers({ db, boss: noBoss(), provider: READER_MODE.FIXTURE, readerFor: () => reader });
    // The guard refuses before page 2: the job line carries what page 1 read, as the pass end does (R1). Morgan's
    // first page is FIXTURE_PAGE_SIZE messages served whole, four of them stored (Falcon x3, Cobra x1).
    const read = { pages: 1, fetched: FIXTURE_PAGE_SIZE, excluded: 0, stored: 4 };
    await expect(handlers.sync({ tenantId: tenant.id, sourceId: sourceIds.get(MORGAN)! })).resolves.toEqual({
      status: 'refused',
      reason: 'source_paused',
      ...read,
    });
    const [end] = ends(await passRows(tenant.id));
    expect(end.detail).toMatchObject({ status: 'refused', reason: 'source_paused', checkpointAdvanced: true, ...read });
    if (databaseUrl) expect(verifyChain(chainOf(tenant.id))).toMatchObject({ ok: true });
  });
});

describe('discovery_worker_enabled turned off between pages', () => {
  it('ends the pass paused / flag_off', async () => {
    const { tenant, sourceIds } = await tenantWith('pause', [MORGAN]);
    const fixture = innerFixtureReader();
    const reader: ContentSource = {
      kind: fixture.kind,
      backfill: (source, checkpoint) => ({
        async *[Symbol.asyncIterator]() {
          let first = true;
          for await (const page of fixture.backfill(source, checkpoint)) {
            // While the first page is in flight, the operator pauses the worker: the flag re-read after
            // that page stops the pass there.
            if (first) await setWorkerFlag(false);
            first = false;
            yield page;
          }
        },
      }),
      delta: (source, token) => fixture.delta(source, token),
    };
    const handlers = createWorkerHandlers({
      db,
      boss: noBoss(),
      provider: READER_MODE.FIXTURE,
      readerFor: () => reader,
      flagRecheckMs: 0,
    });
    try {
      // The job line's counts (#344 G2) cover the one page read before the pause: Morgan's first page is
      // FIXTURE_PAGE_SIZE messages, all served whole, and four of them (Falcon x3, Cobra x1) are stored.
      await expect(handlers.sync({ tenantId: tenant.id, sourceId: sourceIds.get(MORGAN)! })).resolves.toEqual({
        status: 'paused',
        pages: 1,
        fetched: FIXTURE_PAGE_SIZE,
        excluded: 0,
        stored: 4,
        screened: FIXTURE_PAGE_SIZE,
        flagged: 0,
        unchanged: 0,
      });
    } finally {
      await setWorkerFlag(true);
    }
    const [end] = ends(await passRows(tenant.id));
    expect(end.detail).toMatchObject({
      status: 'paused',
      reason: 'flag_off',
      pages: 1,
      fetched: FIXTURE_PAGE_SIZE,
      excluded: 0,
      stored: 4,
      checkpointAdvanced: true,
    });
  });
});

describe.skipIf(!databaseUrl)('a checkpoint write the database refuses', () => {
  it('ends the pass failed / P0001, with the stored items counted and no page', async () => {
    const { tenant, sourceIds } = await tenantWith('ckpt', [MORGAN]);
    const sourceId = sourceIds.get(MORGAN)!;
    const trigger = `rp_refuse_checkpoint_${RUN}`;
    psql(`create function public.${trigger}() returns trigger language plpgsql as $$
      begin raise exception 'test refuses the checkpoint' using errcode = 'P0001'; end $$;
      create trigger ${trigger} before update of delta_checkpoint on public.content_sources
        for each row when (new.id = '${sourceId}' and new.delta_checkpoint is not null) execute function public.${trigger}();`);
    try {
      const handlers = createWorkerHandlers({ db, boss: noBoss(), provider: READER_MODE.FIXTURE });
      await expect(handlers.sync({ tenantId: tenant.id, sourceId })).rejects.toThrow('checkpoint update failed (P0001)');
    } finally {
      psql(`drop trigger if exists ${trigger} on public.content_sources; drop function if exists public.${trigger}();`);
    }
    const [end] = ends(await passRows(tenant.id));
    expect(end.detail).toMatchObject({ status: 'failed', reason: 'P0001', pages: 0, checkpointAdvanced: false });
    expect(end.detail.stored).toBeGreaterThan(0);
    expect(verifyChain(chainOf(tenant.id))).toMatchObject({ ok: true });
  });
});

describe('runOnce over two sources', () => {
  it('records two passes sharing the run id, and lists them in its summary', async () => {
    const { tenant, sourceIds } = await tenantWith('once', [ALEX, MORGAN]);
    const summary = await runOnce({ tenantId: tenant.id, db, provider: READER_MODE.FIXTURE });
    if (summary.status !== 'ok') throw new Error(`run skipped: ${summary.reason}`);
    const rows = await passRows(tenant.id);
    const starts = rows.filter((row) => row.action === 'discovery.reader_pass_started');
    expect(starts).toHaveLength(2);
    expect(starts.map((row) => row.detail.runId)).toEqual([summary.runId, summary.runId]);
    expect(new Set(starts.map((row) => row.detail.sourceId))).toEqual(new Set(sourceIds.values()));
    expect(summary.passes).toEqual(
      expect.arrayContaining(starts.map((row) => ({ sourceId: row.detail.sourceId, passId: row.detail.passId }))),
    );
    expect(ends(rows).map((row) => row.detail.status)).toEqual(['complete', 'complete']);
    expect(ends(rows).reduce((sum, row) => sum + (row.detail.pages as number), 0)).toBeGreaterThanOrEqual(
      Math.ceil((FIXTURE_PAGE_SIZE + 2) / FIXTURE_PAGE_SIZE),
    );
    if (databaseUrl) expect(verifyChain(chainOf(tenant.id))).toMatchObject({ ok: true });
  });
});

describe('a pass that never finishes', () => {
  it('leaves its start only', async () => {
    const { tenant, sourceIds } = await tenantWith('crash', [STORM]);
    const pass = await beginPass(
      db,
      { tenantId: tenant.id, sourceId: sourceIds.get(STORM)!, jobId: null },
      workerIdentity(READER_MODE.FIXTURE),
    );
    const rows = await passRows(tenant.id);
    expect(rows.map((row) => row.action)).toEqual(['discovery.reader_pass_started']);
    expect(rows[0].detail.passId).toBe(pass.passId);
  });
});
