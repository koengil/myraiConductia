// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EXPORT_COLUMNS,
  EXPORT_FORMAT,
  collectExport,
  parseExportArgs,
  prepareOutDir,
  repoRoots,
  writeExport,
} from '../scripts/discovery-export';

/*
 * scripts/discovery-export.ts, the eval's input (phase 5). The export is
 * metadata only and tenant-scoped; these tests pin both against a fake client
 * that records every query. The same script runs against a real database in
 * tests/integration/discovery-export.test.ts.
 */

// Temp directories made by a test, removed after it so runs leave nothing behind.
const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;
type Query = { table: string; columns: string; filters: string[] };

/** A read-only PostgREST stand-in: eq, in, gt, order, limit and range over in-memory rows. */
function fakeDb(tables: Record<string, Row[]>) {
  const queries: Query[] = [];
  const db = {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const query: Query = { table, columns: '', filters: [] };
      queries.push(query);
      let start = 0;
      let end = Number.POSITIVE_INFINITY;
      const builder = {
        select(columns: string) {
          query.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          query.filters.push(`eq:${column}`);
          rows = rows.filter((r) => r[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          query.filters.push(`in:${column}`);
          rows = rows.filter((r) => values.includes(r[column]));
          return builder;
        },
        gt(column: string, value: string) {
          rows = rows.filter((r) => String(r[column]) > value);
          return builder;
        },
        order(column: string) {
          rows.sort((a, b) => String(a[column]).localeCompare(String(b[column])));
          return builder;
        },
        limit(n: number) {
          end = n;
          return builder;
        },
        range(from: number, to: number) {
          start = from;
          end = to - from + 1;
          return builder;
        },
        then(resolve: (value: { data: Row[]; error: null }) => unknown) {
          const data = rows.slice(start, start + end).map((row) => {
            const picked: Row = {};
            for (const column of query.columns.split(',').map((c) => c.trim())) picked[column] = row[column];
            return picked;
          });
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

function corpus() {
  const source = (id: string, tenant: string, kind = 'mailbox') => ({
    id,
    tenant_id: tenant,
    kind,
    address: `${id}@bank.example`,
    owner_user_id: id === 's1' ? 'u1' : null,
    status: 'active',
    backfill_completed_at: '2026-03-01T00:00:00Z',
    last_synced_at: '2026-03-01T00:00:00Z',
    delta_checkpoint: 'https://graph.microsoft.com/delta?token=secret',
  });
  const item = (id: string, tenant: string, mid: string) => ({
    id,
    tenant_id: tenant,
    kind: 'message',
    subject: `Project Falcon subject ${id}`,
    participants: [{ address: 'dana.price@heliotrope.example', name: 'Dana Price' }],
    sent_at: '2026-02-03T09:12:00Z',
    internet_message_id: mid,
    conversation_id: `conv-${id}`,
    drive_item_key: null,
    drive_path: null,
    content_hash: 'hash',
    sensitivity: 'standard',
  });
  return {
    content_sources: [source('s1', TENANT), source('s2', TENANT, 'sharepoint_site'), source('sx', OTHER)],
    routing_ledger: [
      { source_id: 's1', provider_item_id: 'p1', item_hash: 'h1', decision: 'routed', method: 'codename', confidence: 1, skip_reason: null, conversation_id: null, internet_message_id: null, run_id: 'r1', recorded_at: 't' },
      { source_id: 's1', provider_item_id: 'p2', item_hash: 'h2', decision: 'unrouted', method: null, confidence: null, skip_reason: null, conversation_id: 'conv-x', internet_message_id: '<late@bank.example>', run_id: 'r1', recorded_at: 't' },
      { source_id: 's2', provider_item_id: 'd1', item_hash: 'h3', decision: 'skipped', method: null, confidence: null, skip_reason: 'image_only', conversation_id: null, internet_message_id: null, run_id: 'r1', recorded_at: 't' },
      { source_id: 'sx', provider_item_id: 'px', item_hash: 'h4', decision: 'routed', method: 'codename', confidence: 1, skip_reason: null, conversation_id: null, internet_message_id: null, run_id: 'r2', recorded_at: 't' },
    ],
    source_items: [item('i1', TENANT, '<f1@bank.example>'), item('ix', OTHER, '<other@bank.example>')],
    source_item_texts: [{ source_item_id: 'i1', body_text: 'BODY TEXT NEVER EXPORTED', attachment_text: [] }],
    source_item_sources: [
      { source_item_id: 'i1', content_source_id: 's1', provider_item_id: 'p1', observed_at: 't' },
      { source_item_id: 'ix', content_source_id: 'sx', provider_item_id: 'px', observed_at: 't' },
    ],
    deal_candidates: [
      { id: 'c1', tenant_id: TENANT, cluster_key: 'codename:falcon', discovery_state: 'proposed', merged_into_id: null, promoted_deal_id: null, proposed_name: 'Project Falcon', codename_guess: 'Project Falcon', parties: [{ name: 'Heliotrope', domain: 'heliotrope.example' }], first_seen_at: 'a', last_seen_at: 'b', deal_side: 'unknown', confidence: '1', discovery_run_id: 'r1', pinned: false },
      { id: 'cx', tenant_id: OTHER, cluster_key: 'codename:cobra', discovery_state: 'proposed', merged_into_id: null, promoted_deal_id: null, proposed_name: 'Project Cobra', codename_guess: 'Project Cobra', parties: [], first_seen_at: null, last_seen_at: null, deal_side: 'unknown', confidence: null, discovery_run_id: 'r2', pinned: false },
    ],
    evidence_links: [
      { id: 'l1', candidate_id: 'c1', deal_id: null, source_item_id: 'i1', method: 'codename', confidence: '1', route_tier: 'firm', state: 'proposed', pinned_by_correction_id: null },
      { id: 'lx', candidate_id: 'cx', deal_id: null, source_item_id: 'ix', method: 'codename', confidence: '1', route_tier: 'firm', state: 'proposed', pinned_by_correction_id: null },
    ],
  };
}

describe('collectExport', () => {
  it('exports one tenant only, in the harness format', async () => {
    const { db } = fakeDb(corpus());
    const data = await collectExport(db, TENANT);
    expect(data.sources.map((s) => [s.id, s.kind, s.ownerAssigned])).toEqual([
      ['s1', 'mailbox', true],
      ['s2', 'sharepoint_site', false],
    ]);
    expect(data.ledger.map((r) => r.providerItemId)).toEqual(['p1', 'p2', 'd1']);
    expect(data.ledger[1]).toEqual({
      sourceId: 's1',
      providerItemId: 'p2',
      decision: 'unrouted',
      method: null,
      confidence: null,
      skipReason: null,
      conversationId: 'conv-x',
      internetMessageId: '<late@bank.example>',
      providerThreadId: null,
      policyVersion: null,
      exclusionRule: null,
      runId: 'r1',
      recordedAt: 't',
    });
    expect(data.ledger[2]).toMatchObject({ decision: 'skipped', skipReason: 'image_only' });
    expect(data.items).toEqual([
      {
        id: 'i1',
        kind: 'message',
        internetMessageId: '<f1@bank.example>',
        conversationId: 'conv-i1',
        driveItemKey: null,
        drivePath: null,
        sentAt: '2026-02-03T09:12:00Z',
        sensitivity: 'standard',
      },
    ]);
    expect(data.provenance).toEqual([{ sourceItemId: 'i1', sourceId: 's1', providerItemId: 'p1' }]);
    expect(data.candidates.map((c) => [c.id, c.proposedName, c.confidence])).toEqual([['c1', 'Project Falcon', 1]]);
    expect(data.candidates[0].parties).toEqual([{ name: 'Heliotrope', domain: 'heliotrope.example' }]);
    expect(data.links.map((l) => [l.id, l.candidateId, l.routeTier, l.confidence])).toEqual([['l1', 'c1', 'firm', 1]]);
  });

  it('never reads text, subjects, participants, addresses, hashes or checkpoints', async () => {
    const { db, queries } = fakeDb(corpus());
    const data = await collectExport(db, TENANT);
    expect(queries.map((q) => q.table)).not.toContain('source_item_texts');
    const forbidden = /\b(subject|participants|body_text|attachment_text|content_hash|item_hash|address|delta_checkpoint|last_error)\b/;
    for (const q of queries) expect(q.columns, q.table).not.toMatch(forbidden);
    for (const columns of Object.values(EXPORT_COLUMNS)) expect(columns).not.toMatch(forbidden);
    const json = JSON.stringify(data);
    expect(json).not.toContain('BODY TEXT');
    expect(json).not.toContain('subject');
    expect(json).not.toContain('dana.price');
    expect(json).not.toContain('token=secret');
  });

  it('exports the exclusion policy\'s skips as ids and numbers: version, rule id, thread id (#263)', async () => {
    const tables = corpus();
    (tables.routing_ledger as Array<Record<string, unknown>>).push({
      source_id: 's1',
      provider_item_id: 'g-9',
      item_hash: 'METADATAHASH',
      decision: 'skipped',
      method: null,
      confidence: null,
      skip_reason: 'policy_thread_excluded',
      conversation_id: null,
      internet_message_id: null,
      provider_thread_id: 'thread-9',
      policy_version: 3,
      exclusion_rule: 'privileged-label',
      run_id: 'r1',
      recorded_at: 't',
    });
    const { db } = fakeDb(tables);
    const data = await collectExport(db, TENANT);
    expect(data.ledger.find((r) => r.providerItemId === 'g-9')).toMatchObject({
      decision: 'skipped',
      skipReason: 'policy_thread_excluded',
      providerThreadId: 'thread-9',
      policyVersion: 3,
      exclusionRule: 'privileged-label',
    });
    // The metadata hash is never exported.
    expect(JSON.stringify(data)).not.toContain('METADATAHASH');
  });

  it('scopes every query to the tenant, directly or through its sources and items', async () => {
    const { db, queries } = fakeDb(corpus());
    await collectExport(db, TENANT);
    const scope: Record<string, string> = {
      content_sources: 'eq:tenant_id',
      routing_ledger: 'eq:source_id',
      source_items: 'eq:tenant_id',
      source_item_sources: 'in:source_item_id',
      evidence_links: 'in:source_item_id',
      deal_candidates: 'eq:tenant_id',
    };
    for (const q of queries) expect(q.filters, q.table).toContain(scope[q.table]);
  });

  it('pages past a thousand rows without dropping or repeating one', async () => {
    const tables = corpus();
    tables.routing_ledger = Array.from({ length: 2501 }, (_, i) => ({
      ...tables.routing_ledger[1],
      provider_item_id: `p${String(i).padStart(5, '0')}`,
    }));
    const { db } = fakeDb(tables);
    const data = await collectExport(db, TENANT);
    expect(data.ledger).toHaveLength(2501);
    expect(new Set(data.ledger.map((r) => r.providerItemId)).size).toBe(2501);
  });
});

describe('arguments and output', () => {
  it('requires a tenant uuid and an output directory', () => {
    expect(parseExportArgs(['--tenant', TENANT, '--out', '/tmp/x'])).toEqual({ tenantId: TENANT, outDir: '/tmp/x' });
    expect(() => parseExportArgs(['--out', '/tmp/x'])).toThrow(/--tenant <uuid> is required/);
    expect(() => parseExportArgs(['--tenant', 'dev', '--out', '/tmp/x'])).toThrow(/--tenant <uuid>/);
    expect(() => parseExportArgs(['--tenant', TENANT])).toThrow(/--out <dir> is required/);
    expect(() => parseExportArgs(['--tenant', TENANT, '--out', '/tmp/x', '--all'])).toThrow(/unknown argument --all/);
  });

  it('refuses an output directory inside the repo, except under evals/out', () => {
    const repo = tempDir('dd-export-repo-');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'conductia' }));
    const inside = join(repo, 'docs', 'export');
    expect(() => prepareOutDir(inside, repo)).toThrow(/inside the repository/);
    expect(existsSync(inside)).toBe(false);
    expect(prepareOutDir(join(repo, 'evals', 'out', 'week2'), repo)).toBe(join(repo, 'evals', 'out', 'week2'));
    const outside = tempDir('dd-export-out-');
    expect(prepareOutDir(outside, repo)).toBe(outside);
  });

  it('takes the repo roots from git: the working tree first, then the main checkout', () => {
    const roots = repoRoots(join(process.cwd(), 'src', 'lib'));
    expect(roots[0]).toBe(realpathSync.native(process.cwd()));
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    expect(roots).toContain(dirname(common));
  });

  it('refuses an output inside the main checkout of a linked worktree (review item 8)', () => {
    // The degenerate case: the worktree sits outside the main checkout, so a
    // walk up from the worktree never meets the main checkout's files.
    const base = realpathSync.native(tempDir('dd-export-git-'));
    const main = join(base, 'main');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' });
    mkdirSync(main);
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'x');
    git('worktree', 'add', '-q', join(base, 'wt'));
    const roots = repoRoots(join(base, 'wt'));
    expect(roots).toEqual([join(base, 'wt'), main]);
    const inMain = join(main, 'exports');
    expect(() => prepareOutDir(inMain, roots)).toThrow(/inside the repository/);
    expect(existsSync(inMain)).toBe(false);
    expect(prepareOutDir(join(base, 'wt', 'evals', 'out', 'x'), roots)).toBe(join(base, 'wt', 'evals', 'out', 'x'));
  });

  it('never writes over an earlier export (review item 9)', async () => {
    const { db } = fakeDb(corpus());
    const data = await collectExport(db, TENANT);
    const dir = tempDir('dd-export-');
    writeExport(dir, TENANT, data, '2026-09-26T10:15:00.000Z');
    const before = readFileSync(join(dir, 'manifest.json'), 'utf8');
    expect(() => writeExport(dir, TENANT, data, '2026-09-27T00:00:00.000Z')).toThrow(/already holds an export/);
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(before);
    // One stray file of an earlier export is enough to refuse, and nothing is written.
    const partial = tempDir('dd-export-');
    writeFileSync(join(partial, 'links.jsonl'), '');
    expect(() => writeExport(partial, TENANT, data, '2026-09-26T10:15:00.000Z')).toThrow(/links\.jsonl/);
    expect(existsSync(join(partial, 'manifest.json'))).toBe(false);
  });

  it('writes owner-only JSONL files and a manifest that counts them', async () => {
    const { db } = fakeDb(corpus());
    const data = await collectExport(db, TENANT);
    const dir = tempDir('dd-export-');
    mkdirSync(dir, { recursive: true });
    const manifest = writeExport(dir, TENANT, data, '2026-09-26T10:15:00.000Z');
    expect(manifest).toEqual({
      format: EXPORT_FORMAT,
      tenantId: TENANT,
      exportedAt: '2026-09-26T10:15:00.000Z',
      counts: {
        'sources.jsonl': 2,
        'ledger.jsonl': 3,
        'items.jsonl': 1,
        'provenance.jsonl': 1,
        'candidates.jsonl': 1,
        'links.jsonl': 1,
      },
    });
    const ledger = readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))).toEqual(manifest);
    for (const file of ['manifest.json', 'ledger.jsonl', 'items.jsonl']) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
  });
});
