import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '../src/lib/constants/tables';

/*
 * The deal-discovery eval's input (phase 5, design Q15): a read-only export of
 * one tenant's discovery state, as JSONL, for the harness in
 * evals/deal-discovery to score against an answer key held outside the repo.
 *
 *   npm run discovery:export -- --tenant <uuid> --out <dir>
 *
 * Metadata only. It never reads source_item_texts, and it selects no subject,
 * participant, body or hash column: identifiers, dates, decisions and the
 * candidates' own names and parties, which the harness needs to match deals.
 * It prints counts and the output path, nothing from the rows.
 *
 * It reads with the service role (the worker's view, across every owner) and
 * scopes every query to --tenant: sources, items and candidates by tenant_id;
 * the ledger by the tenant's sources; provenance and links by the tenant's
 * items. It writes nothing to the database.
 *
 *   <dir>/manifest.json     { format, tenantId, exportedAt, counts }
 *   <dir>/sources.jsonl     id, kind, status, ownerAssigned, sync dates (no address)
 *   <dir>/ledger.jsonl      every item read: decision, method, confidence, skip
 *                           reason; an unrouted message's conversation and
 *                           Internet Message-ID (phase 4); and, on an item the
 *                           exclusion policy skipped (#263), the policy version
 *                           and rule id, plus the provider thread id. Ids and
 *                           numbers only: never the rule's condition (a domain,
 *                           an address, a label) and never the metadata hash
 *   <dir>/items.jsonl       each stored item's identity: Message-ID,
 *                           conversation, drive item key and path, date
 *   <dir>/provenance.jsonl  which source each stored item was seen in
 *   <dir>/candidates.jsonl  state, name, codename, parties, date range
 *   <dir>/links.jsonl       item -> candidate (or deal) evidence links
 *
 * With these the harness splits item recall into never read, read but
 * unrouted (late thread or other), attachment-only and skipped documents.
 *
 * Not a snapshot: the REST API has no read transaction, so run it while the
 * worker is paused (discovery_worker_enabled off) or idle. The manifest's
 * counts let the harness refuse a truncated export. --out must be outside the
 * repo (this worktree and the main checkout git names for it), or under
 * evals/out (gitignored); files are written owner-only, and never over an
 * earlier export: a directory that already holds one is refused.
 */

// v2 (#263): a ledger row gains providerThreadId, policyVersion and exclusionRule, and skipReason gains the four
// exclusion-policy reasons. The harness refuses an unknown or a missing field, so the format moves with them.
export const EXPORT_FORMAT = 'conductia.discovery-export/v2';

export const EXPORT_FILES = {
  sources: 'sources.jsonl',
  ledger: 'ledger.jsonl',
  items: 'items.jsonl',
  provenance: 'provenance.jsonl',
  candidates: 'candidates.jsonl',
  links: 'links.jsonl',
} as const;

const PAGE = 1000;
const IN_CHUNK = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Rows, as the harness reads them (evals/deal-discovery/src/exportData.ts) ─

export type ExportSource = {
  id: string;
  kind: string;
  status: string;
  ownerAssigned: boolean;
  backfillCompletedAt: string | null;
  lastSyncedAt: string | null;
};

export type ExportLedgerRow = {
  sourceId: string;
  providerItemId: string;
  decision: string;
  method: string | null;
  confidence: number | null;
  skipReason: string | null;
  conversationId: string | null;
  internetMessageId: string | null;
  /** The provider's thread id: on a message the exclusion policy skipped, and on Gmail rows read since #263. */
  providerThreadId: string | null;
  /** The exclusion policy version that skipped the item, when one did. */
  policyVersion: number | null;
  /** The id of the rule that skipped it (an operator-chosen slug, not the rule's condition). */
  exclusionRule: string | null;
  runId: string;
  recordedAt: string;
};

export type ExportItem = {
  id: string;
  kind: string;
  internetMessageId: string | null;
  conversationId: string | null;
  driveItemKey: string | null;
  drivePath: string | null;
  sentAt: string | null;
  sensitivity: string;
};

export type ExportProvenance = { sourceItemId: string; sourceId: string; providerItemId: string };

export type ExportCandidate = {
  id: string;
  clusterKey: string;
  discoveryState: string;
  mergedIntoId: string | null;
  promotedDealId: string | null;
  proposedName: string;
  codenameGuess: string | null;
  parties: unknown;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  dealSide: string;
  confidence: number | null;
};

export type ExportLink = {
  id: string;
  candidateId: string | null;
  dealId: string | null;
  sourceItemId: string;
  method: string;
  confidence: number | null;
  routeTier: string;
  state: string;
};

export type DiscoveryExport = {
  sources: ExportSource[];
  ledger: ExportLedgerRow[];
  items: ExportItem[];
  provenance: ExportProvenance[];
  candidates: ExportCandidate[];
  links: ExportLink[];
};

// The columns each query selects. Nothing else is ever read.
export const EXPORT_COLUMNS = {
  [TABLE.CONTENT_SOURCES]: 'id, kind, status, owner_user_id, backfill_completed_at, last_synced_at',
  [TABLE.ROUTING_LEDGER]:
    'source_id, provider_item_id, decision, method, confidence, skip_reason, conversation_id, internet_message_id, provider_thread_id, policy_version, exclusion_rule, run_id, recorded_at',
  [TABLE.SOURCE_ITEMS]: 'id, kind, internet_message_id, conversation_id, drive_item_key, drive_path, sent_at, sensitivity',
  [TABLE.SOURCE_ITEM_SOURCES]: 'source_item_id, content_source_id, provider_item_id',
  [TABLE.DEAL_CANDIDATES]:
    'id, cluster_key, discovery_state, merged_into_id, promoted_deal_id, proposed_name, codename_guess, parties, first_seen_at, last_seen_at, deal_side, confidence',
  [TABLE.EVIDENCE_LINKS]: 'id, candidate_id, deal_id, source_item_id, method, confidence, route_tier, state',
} as const;

type Row = Record<string, unknown>;

function fail(step: string, error: { message: string } | null): void {
  if (error) throw new Error(`discovery export: ${step} failed: ${error.message}`);
}

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * Every row of one table matching `scope`, in keyset pages on a unique
 * column: each page starts after the last key of the one before, so a row
 * inserted while the export runs cannot shift a page and duplicate or drop
 * another.
 */
async function readKeyset(
  db: SupabaseClient,
  table: keyof typeof EXPORT_COLUMNS,
  key: string,
  scope: { eq?: [string, string]; in?: [string, string[]] },
): Promise<Row[]> {
  const rows: Row[] = [];
  let after: string | null = null;
  for (;;) {
    let query = db.from(table).select(EXPORT_COLUMNS[table]).order(key, { ascending: true }).limit(PAGE);
    if (scope.eq) query = query.eq(scope.eq[0], scope.eq[1]);
    if (scope.in) query = query.in(scope.in[0], scope.in[1]);
    if (after !== null) query = query.gt(key, after);
    const { data, error } = await query;
    fail(`${table} read`, error);
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = String(page[page.length - 1][key]);
  }
}

/** Reads one tenant's discovery metadata. Select only; never source_item_texts. */
export async function collectExport(db: SupabaseClient, tenantId: string): Promise<DiscoveryExport> {
  const sourceRows = await readKeyset(db, TABLE.CONTENT_SOURCES, 'id', { eq: ['tenant_id', tenantId] });
  const sources: ExportSource[] = sourceRows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    status: String(r.status),
    ownerAssigned: r.owner_user_id !== null && r.owner_user_id !== undefined,
    backfillCompletedAt: text(r.backfill_completed_at),
    lastSyncedAt: text(r.last_synced_at),
  }));

  // The ledger's key is (source_id, provider_item_id): page each source on
  // provider_item_id.
  const ledger: ExportLedgerRow[] = [];
  for (const source of sources) {
    const rows = await readKeyset(db, TABLE.ROUTING_LEDGER, 'provider_item_id', { eq: ['source_id', source.id] });
    for (const r of rows) {
      ledger.push({
        sourceId: String(r.source_id),
        providerItemId: String(r.provider_item_id),
        decision: String(r.decision),
        method: text(r.method),
        confidence: num(r.confidence),
        skipReason: text(r.skip_reason),
        conversationId: text(r.conversation_id),
        internetMessageId: text(r.internet_message_id),
        providerThreadId: text(r.provider_thread_id),
        policyVersion: num(r.policy_version),
        exclusionRule: text(r.exclusion_rule),
        runId: String(r.run_id),
        recordedAt: String(r.recorded_at),
      });
    }
  }

  const itemRows = await readKeyset(db, TABLE.SOURCE_ITEMS, 'id', { eq: ['tenant_id', tenantId] });
  const items: ExportItem[] = itemRows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    internetMessageId: text(r.internet_message_id),
    conversationId: text(r.conversation_id),
    driveItemKey: text(r.drive_item_key),
    drivePath: text(r.drive_path),
    sentAt: text(r.sent_at),
    sensitivity: String(r.sensitivity),
  }));

  // Provenance and links hang off the tenant's items: their keys are not
  // single columns (provenance) or reach a deal instead of a candidate
  // (links, after promotion), so they are read by item, chunk by chunk.
  const provenance: ExportProvenance[] = [];
  const links: ExportLink[] = [];
  for (const chunk of chunks(items.map((i) => i.id))) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from(TABLE.SOURCE_ITEM_SOURCES)
        .select(EXPORT_COLUMNS[TABLE.SOURCE_ITEM_SOURCES])
        .in('source_item_id', chunk)
        .order('source_item_id', { ascending: true })
        .order('content_source_id', { ascending: true })
        .range(from, from + PAGE - 1);
      fail(`${TABLE.SOURCE_ITEM_SOURCES} read`, error);
      const page = (data ?? []) as unknown as Row[];
      for (const r of page) {
        provenance.push({
          sourceItemId: String(r.source_item_id),
          sourceId: String(r.content_source_id),
          providerItemId: String(r.provider_item_id),
        });
      }
      if (page.length < PAGE) break;
    }
    const linkRows = await readKeyset(db, TABLE.EVIDENCE_LINKS, 'id', { in: ['source_item_id', chunk] });
    for (const r of linkRows) {
      links.push({
        id: String(r.id),
        candidateId: text(r.candidate_id),
        dealId: text(r.deal_id),
        sourceItemId: String(r.source_item_id),
        method: String(r.method),
        confidence: num(r.confidence),
        routeTier: String(r.route_tier),
        state: String(r.state),
      });
    }
  }
  // Code-point order, the same on every machine (localeCompare follows the host's locale).
  links.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const candidateRows = await readKeyset(db, TABLE.DEAL_CANDIDATES, 'id', { eq: ['tenant_id', tenantId] });
  const candidates: ExportCandidate[] = candidateRows.map((r) => ({
    id: String(r.id),
    clusterKey: String(r.cluster_key),
    discoveryState: String(r.discovery_state),
    mergedIntoId: text(r.merged_into_id),
    promotedDealId: text(r.promoted_deal_id),
    proposedName: String(r.proposed_name),
    codenameGuess: text(r.codename_guess),
    parties: Array.isArray(r.parties) ? r.parties : [],
    firstSeenAt: text(r.first_seen_at),
    lastSeenAt: text(r.last_seen_at),
    dealSide: String(r.deal_side),
    confidence: num(r.confidence),
  }));

  return { sources, ledger, items, provenance, candidates, links };
}

// ── Arguments and output ─────────────────────────────────────────────────────

export type ExportArgs = { tenantId: string; outDir: string };

export function parseExportArgs(argv: string[]): ExportArgs {
  let tenantId = '';
  let outDir = '';
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--tenant' || flag === '--out') {
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--tenant') tenantId = value;
      else outDir = value;
      i += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!UUID.test(tenantId)) throw new Error('--tenant <uuid> is required: the Conductia tenant to export');
  if (!outDir) throw new Error('--out <dir> is required');
  return { tenantId, outDir };
}

/**
 * The roots `from` belongs to, from git: the working tree, then the main
 * checkout (the parent of `git rev-parse --git-common-dir`). In a linked
 * worktree they differ, and a directory inside the main checkout is still
 * inside the repository. Fails closed: without git, the export does not guess.
 */
export function repoRoots(from: string = process.cwd()): string[] {
  let output: string;
  try {
    output = execFileSync('git', ['-C', from, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('git rev-parse failed, so the repository root is unknown. Run the export from a git checkout.');
  }
  const [topLevel, commonDir] = output.trim().split('\n');
  if (!topLevel || !commonDir) throw new Error('git rev-parse returned no repository root.');
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  return [...new Set([topLevel, mainRoot])];
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The output directory, created owner-only. Refused inside the repo unless it
 * is under evals/out (gitignored) of this checkout, `roots[0]`: an export of
 * a bank's tenant is metadata of real mail and must not be committed. Checked
 * before the directory is created, then again with symlinks resolved.
 */
export function prepareOutDir(outDir: string, repoRoot: string | readonly string[]): string {
  const roots = typeof repoRoot === 'string' ? [repoRoot] : [...repoRoot];
  const refuse = () =>
    new Error('--out points inside the repository. Use evals/out (gitignored) or a directory outside the repo.');
  const target = resolve(outDir);
  const allowed = resolve(roots[0], 'evals', 'out');
  if (roots.some((r) => isInside(resolve(r), target)) && !isInside(allowed, target)) throw refuse();
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const real = realpathSync.native(target);
  const realRoots = roots.map((r) => realpathSync.native(r));
  if (realRoots.some((r) => isInside(r, real)) && !isInside(join(realRoots[0], 'evals', 'out'), real)) throw refuse();
  return real;
}

export type ExportManifest = {
  format: typeof EXPORT_FORMAT;
  tenantId: string;
  exportedAt: string;
  counts: Record<string, number>;
};

/**
 * Writes the JSONL files and, last, the manifest that counts them. Never over
 * an earlier export: every file is created with `wx`, and a directory that
 * already holds any of them is refused before anything is written.
 */
export function writeExport(dir: string, tenantId: string, data: DiscoveryExport, exportedAt: string): ExportManifest {
  const names = [...Object.values(EXPORT_FILES), 'manifest.json'];
  const existing = names.filter((name) => existsSync(join(dir, name)));
  if (existing.length > 0) {
    throw new Error(`${dir} already holds an export (${existing.join(', ')}). Exports are never overwritten: pick another --out.`);
  }
  const counts: Record<string, number> = {};
  for (const [key, file] of Object.entries(EXPORT_FILES)) {
    const rows = data[key as keyof DiscoveryExport] as unknown[];
    counts[file] = rows.length;
    const path = join(dir, file);
    writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
  }
  const manifest: ExportManifest = { format: EXPORT_FORMAT, tenantId, exportedAt, counts };
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(manifestPath, 0o600);
  return manifest;
}

async function main(): Promise<void> {
  const args = parseExportArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)');
  }
  const dir = prepareOutDir(args.outDir, repoRoots());
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const exportedAt = new Date().toISOString();
  const data = await collectExport(db, args.tenantId);
  if (data.sources.length === 0) {
    throw new Error(`Tenant ${args.tenantId} has no content sources. Nothing to export.`);
  }
  const manifest = writeExport(dir, args.tenantId, data, exportedAt);
  for (const [file, count] of Object.entries(manifest.counts)) console.log(`${file}: ${count} rows`);
  console.log(`✅ Exported tenant ${args.tenantId} to ${dir}`);
}

if (process.argv[1]?.endsWith('discovery-export.ts')) {
  main().catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
