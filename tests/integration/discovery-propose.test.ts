import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { READER_MODE } from '@/lib/constants/discovery';
import { messageKey } from '@/lib/discovery/propose/key';
import { PROPOSE_FLAG } from '@/lib/discovery/propose/step';
import { SYNTHETIC_MESSAGE_IDS } from '@/lib/modelGateway/syntheticCorpus.generated';
import { runOnce, summaryLine, type RunSummary } from '../../worker/classify';
import { PROPOSE_REPLY_TABLE } from '../helpers/proposeReplyTable';
import { createDiscoveryTenant, DEMO_LATE_MAIL_DIRECTORY } from './helpers/discoveryTenant';

/*
 * The demo-only proposal step (#460; delete with #459) against a REAL database, on the committed recorded stub
 * (propose.v2.stub.json, chosen the way classify-once chooses it). A coverage pass reads the demo corpus first. A
 * classify-once --propose run then re-reads every mailbox from the start, asks the step about each message the firm
 * rules left unrouted, and writes one content-free row per answer, while every content_sources column that holds
 * resume state stays byte-identical. A closed lock reads nothing. The CLI case runs the real worker/classify.ts the
 * way the classify-propose task would.
 */

const tenant = createDiscoveryTenant('pp');
const { db, tenantId } = tenant;

/** Every column of a proposal row: no subject, body, address or display name among them. */
const COLUMNS = [
  'archived_at', 'candidate_id', 'content_source_id', 'created_at', 'deal_key', 'deal_name', 'id', 'item_hash', 'message_key', 'model',
  'outcome', 'p_deal', 'p_phase', 'party_domains', 'phase', 'prompt_hash', 'prompt_version', 'response_id', 'run_id',
  'sent_at', 'tenant_id', 'updated_at',
];
/** The deal names the stub's replies propose (new names; one may fold into a rules-found candidate's name). */
const STUB_DEAL_NAMES = new Set(
  Object.values(PROPOSE_REPLY_TABLE).flatMap((r) => (r.deal && 'new_name' in r.deal ? [r.deal.new_name] : [])),
);
const NAMES = /kestrel|osprey|harbor|falcon|heron|@/i;

let previousFlag: { enabled: boolean } | null = null;
async function setProposeFlag(enabled: boolean): Promise<void> {
  const { error } = await db
    .from('feature_flags')
    .upsert({ key: PROPOSE_FLAG, description: 'demo model proposals (integration)', enabled }, { onConflict: 'key' });
  if (error) throw new Error(`flag upsert failed: ${error.message}`);
}

/** Runs `work` with the fixture reader on the demo corpus with its late mail. */
async function onDemo<T>(work: () => Promise<T>): Promise<T> {
  const before = process.env.DISCOVERY_FIXTURE_DIR;
  process.env.DISCOVERY_FIXTURE_DIR = DEMO_LATE_MAIL_DIRECTORY;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.DISCOVERY_FIXTURE_DIR;
    else process.env.DISCOVERY_FIXTURE_DIR = before;
  }
}

/** Every content_sources column a propose run must not move, by source, as Postgres returns them. */
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

async function proposals(): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await db.from('discovery_model_proposals').select('*').eq('tenant_id', tenantId).order('message_key');
  if (error) throw new Error(`proposal read failed: ${error.message}`);
  return data ?? [];
}

/** The distinct Message-IDs the ledger holds as unrouted for the tenant's sources: what a propose run sends. */
async function unroutedMessageIds(): Promise<string[]> {
  const sources = await db.from('content_sources').select('id').eq('tenant_id', tenantId);
  if (sources.error) throw new Error(`source read failed: ${sources.error.message}`);
  const { data, error } = await db
    .from('routing_ledger')
    .select('internet_message_id')
    .eq('decision', 'unrouted')
    .in('source_id', (sources.data ?? []).map((r) => r.id as string));
  if (error) throw new Error(`ledger read failed: ${error.message}`);
  return [...new Set((data ?? []).map((r) => r.internet_message_id as string | null).filter((id): id is string => !!id))];
}

async function passStarts(): Promise<number> {
  const { count, error } = await db
    .from('audit_log')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('action', 'discovery.reader_pass_started');
  if (error) throw new Error(`audit count failed: ${error.message}`);
  return count ?? 0;
}

function ok(summary: RunSummary): Extract<RunSummary, { status: 'ok' }> {
  if (summary.status !== 'ok') throw new Error(`pass skipped: ${summary.reason} ${summary.code ?? ''}`);
  return summary;
}

beforeAll(async () => {
  await tenant.setup();
  const { data } = await db.from('feature_flags').select('enabled').eq('key', PROPOSE_FLAG).maybeSingle();
  previousFlag = data as { enabled: boolean } | null;
  await setProposeFlag(true);
});
afterAll(async () => {
  await db.from('discovery_model_proposals').delete().eq('tenant_id', tenantId);
  await db.from('content_sources').delete().eq('tenant_id', tenantId);
  await tenant.cleanup();
  if (previousFlag) await setProposeFlag(previousFlag.enabled);
  else await db.from('feature_flags').delete().eq('key', PROPOSE_FLAG);
});

describe('classify-once --propose on the demo corpus, on the recorded stub (#460)', () => {
  let proposed: Extract<RunSummary, { status: 'ok' }>;

  it('the coverage pass reads the demo corpus whole first', async () => {
    const coverage = await tenant.seedDemo(DEMO_LATE_MAIL_DIRECTORY);
    expect(coverage.routing.fullRead).toBe(true);
    expect(coverage.routing.unrouted).toBeGreaterThan(0);
    expect(coverage.proposed).toBeUndefined();
  });

  it('with the flag off, the propose run is refused and reads nothing', async () => {
    await setProposeFlag(false);
    try {
      const starts = await passStarts();
      const before = await resumeState();
      const summary = await onDemo(() => runOnce({ tenantId, db, provider: READER_MODE.FIXTURE, propose: {} }));
      expect(summary).toEqual({ tenantId, status: 'skipped', reason: 'propose_refused', code: 'flag_off', passes: [] });
      expect(await passStarts()).toBe(starts);
      expect(await resumeState()).toBe(before);
      expect(await proposals()).toEqual([]);
    } finally {
      await setProposeFlag(true);
    }
  });

  it('re-reads every mailbox, writes one content-free row per unrouted message, and moves no resume column', async () => {
    const before = await resumeState();
    proposed = ok(await onDemo(() => runOnce({ tenantId, db, provider: READER_MODE.FIXTURE, propose: {} })));

    expect(proposed.routing.fullRead).toBe(true);
    const t = proposed.proposed!;
    expect(t).toMatchObject({ failed: 0, invalid: 0, skippedNotSynthetic: 0, costUsd: 0 });
    expect(t.deal).toBeGreaterThan(0);
    expect(t.notDeal).toBeGreaterThan(0);
    expect(t.called).toBe(t.deal + t.notDeal);
    expect(await resumeState()).toBe(before);

    // One row per distinct unrouted message the run sent: its identity is the message, hashed.
    const rows = await proposals();
    expect(rows).toHaveLength(t.called);
    const unrouted = await unroutedMessageIds();
    expect(unrouted.every((id) => SYNTHETIC_MESSAGE_IDS.has(id))).toBe(true);
    expect(new Set(rows.map((r) => r.message_key))).toEqual(new Set(unrouted.map(messageKey)));

    // No text column exists, and no row holds an address or a Message-ID.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(COLUMNS);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('@');
    for (const id of unrouted) expect(text.includes(id), id).toBe(false);

    // The stub's deal answers became deal rows; everything else is a not_deal row with no deal on it.
    const deals = rows.filter((r) => r.outcome === 'deal');
    expect(deals).toHaveLength(t.deal);
    for (const row of deals) {
      expect(row.phase).toMatch(/^phase-[1-5]$/);
      expect(STUB_DEAL_NAMES.has(row.deal_name as string) || typeof row.candidate_id === 'string', String(row.deal_key)).toBe(true);
    }
    for (const row of rows.filter((r) => r.outcome !== 'deal')) {
      expect(row).toMatchObject({ outcome: 'not_deal', deal_key: null, deal_name: null, phase: null, candidate_id: null });
    }

    // A replay prices nothing and records no usage.
    const usage = await db.from('ai_usage').select('id').eq('tenant_id', tenantId).eq('task', 'deal_proposal');
    expect(usage.error).toBeNull();
    expect(usage.data).toEqual([]);

    // The line: counts only, labelled as a full read.
    const line = summaryLine(proposed);
    expect(line).toContain('Routing (full read): ');
    expect(line).toMatch(
      new RegExp(`Proposed: called ${t.called}, deal ${t.deal}, new names \\d+, not deal ${t.notDeal}, failed 0, invalid 0, cost \\$0\\.0000, sources skipped \\d+, sources refused 0\\.$`),
    );
    expect(line).not.toMatch(NAMES);
  });

  it('a second propose run asks about nothing already answered, and changes no row', async () => {
    const rows = await proposals();
    const before = await resumeState();
    const again = ok(await onDemo(() => runOnce({ tenantId, db, provider: READER_MODE.FIXTURE, propose: {} })));
    expect(again.proposed).toMatchObject({ called: 0, deal: 0, notDeal: 0, failed: 0 });
    expect(await proposals()).toEqual(rows);
    expect(await resumeState()).toBe(before);
  });

  it('the CLI with --propose prints the line with its Proposed counts, and leaves the resume columns as they were', async () => {
    const before = await resumeState();
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--tenant', tenantId, '--propose'], {
      cwd: process.cwd(),
      env: { ...process.env, DISCOVERY_READER_MODE: 'fixture', DISCOVERY_FIXTURE_DIR: DEMO_LATE_MAIL_DIRECTORY },
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
    expect(lines[0]).toMatch(new RegExp(`^Tenant ${tenantId}: read \\d+ items from 3 sources, `));
    expect(lines[0]).toContain('Routing (full read): ');
    expect(lines[0]).toMatch(/ Proposed: called 0, deal 0, new names 0, not deal 0, failed 0, invalid 0, cost \$0\.0000, sources skipped \d+, sources refused 0\.$/);
    expect(out + err).not.toMatch(NAMES);
    expect(await resumeState()).toBe(before);
  }, 90_000);
});
