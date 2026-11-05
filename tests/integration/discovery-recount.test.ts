import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { READER_MODE } from '@/lib/constants/discovery';
import { runOnce, summaryLine, type RunSummary } from '../../worker/classify';
import { createDiscoveryTenant } from './helpers/discoveryTenant';

/*
 * The coverage count and its full re-read (#460), against a REAL database. A first classify-once pass over the
 * fixture corpus gives the coverage answer as a full read. A second plain pass reads new mail only, so its line says
 * so. classify-once --recount then reads every mailbox again from the start and gives the first pass's counts, while
 * every content_sources column that holds resume state or health stays byte-identical: the serve loop owns them.
 * The CLI case runs the real worker/classify.ts the way the ECS `once` task with a --recount override would.
 */

const tenant = createDiscoveryTenant('rc');
const { db, tenantId } = tenant;

const COVERAGE = { read: 17, routed: 10, unrouted: 7, skipped: 0, collisions: 0, codenames: 2, scopeBlocked: 0 };

/** Every content_sources column a re-read must not move, by source, as Postgres returns them. */
async function resumeState(): Promise<string> {
  const { data, error } = await db
    .from('content_sources')
    .select(
      'id, delta_checkpoint, checkpoint_updated_at, backfill_started_at, backfill_completed_at, last_synced_at, last_error, last_error_at, history_expiry_streak',
    )
    .eq('tenant_id', tenantId)
    .order('id');
  if (error) throw new Error(`content_sources read failed: ${error.message}`);
  return JSON.stringify(data);
}

async function storedCounts() {
  const count = async (table: string) => {
    const { count: n, error } = await db.from(table).select('*', { count: 'exact', head: true }).eq('tenant_id', tenantId);
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    return n ?? 0;
  };
  return { items: await count('source_items'), candidates: await count('deal_candidates') };
}

function ok(summary: RunSummary): Extract<RunSummary, { status: 'ok' }> {
  if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason}`);
  return summary;
}

beforeAll(() => tenant.setup());
afterAll(async () => {
  await db.from('content_sources').delete().eq('tenant_id', tenantId);
  await tenant.cleanup();
});

describe('classify-once --recount: the coverage count of a source something already read (#460)', () => {
  let coverage: Extract<RunSummary, { status: 'ok' }>;

  it('the first pass is the coverage answer: a full read, the four counts partitioning what was read', async () => {
    coverage = ok(await runOnce({ tenantId, db, provider: READER_MODE.FIXTURE }));
    expect(coverage.routing).toEqual({ ...COVERAGE, fullRead: true });
    const { read, routed, unrouted, skipped, collisions } = coverage.routing;
    expect(routed + unrouted + skipped + collisions).toBe(read);
    expect(read).toBe(coverage.itemsRead);
    expect(summaryLine(coverage)).toContain('Routing (full read): of 17 read, routed 10, unrouted 7, skipped 0, collisions 0; codenames 2.');
  });

  it('a second plain pass reads new mail only, and its line says so', async () => {
    const again = ok(await runOnce({ tenantId, db, provider: READER_MODE.FIXTURE }));
    expect(again.routing).toEqual({ read: 0, routed: 0, unrouted: 0, skipped: 0, collisions: 0, codenames: 0, fullRead: false, scopeBlocked: 0 });
    expect(summaryLine(again)).toContain('Routing (new mail only since the last pass): of 0 read');
  });

  it('--recount reads every source whole again, gives the same counts, and moves no resume column', async () => {
    const before = await resumeState();
    const stored = await storedCounts();
    const recount = ok(await runOnce({ tenantId, db, provider: READER_MODE.FIXTURE, reread: true }));
    expect(recount.routing).toEqual(coverage.routing);
    expect(recount.itemsStored).toBe(coverage.itemsStored);
    expect(recount.candidates.every((c) => !c.created)).toBe(true);
    expect(await resumeState()).toBe(before);
    // The upserts it repeated changed nothing.
    expect(await storedCounts()).toEqual(stored);

    // Each source's pass end is recorded as a read that advanced no checkpoint.
    const { data: ends, error } = await db
      .from('audit_log')
      .select('detail')
      .eq('tenant_id', tenantId)
      .eq('action', 'discovery.reader_pass_finished')
      .in('detail->>passId', recount.passes.map((pass) => pass.passId));
    expect(error).toBeNull();
    expect((ends ?? []).map((row) => [row.detail.status, row.detail.checkpointAdvanced])).toEqual(
      recount.passes.map(() => ['complete', false]),
    );
  });

  it('the CLI with --recount prints the full-read line and leaves the resume columns as they were', async () => {
    const before = await resumeState();
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--tenant', tenantId, '--recount'], {
      cwd: process.cwd(),
      env: { ...process.env, DISCOVERY_READER_MODE: 'fixture' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code, err).toBe(0);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^Tenant ${tenantId}: read 17 items from 3 sources, `));
    expect(lines[0]).toContain('Routing (full read): of 17 read, routed 10, unrouted 7, skipped 0, collisions 0; codenames 2. Scope-blocked routes 0. Run ');
    expect(out + err).not.toMatch(/falcon|cobra|@/i);
    expect(await resumeState()).toBe(before);
  }, 90_000);
});
