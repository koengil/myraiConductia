import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/*
 * The tenant purge report (#461): what scripts/discovery/purge-tenant.ts
 * deleted, or would delete, and the source of the bank's written confirmation.
 * One JSON file and one Markdown file per run, owner-only (0600), never over an
 * earlier report, and never inside the repository: the report describes a
 * bank's deleted mail.
 *
 * A report is a prerequisite of a commit, so it is written in three steps: the
 * destination is reserved (checked, created, probed) before any database work;
 * the files are written as `.pending` files, fsynced, before the commit runs;
 * and they are renamed to their final names only after the commit succeeded.
 */

export const PURGE_REPORT_FORMAT = 'conductia.tenant-purge-report/v1';

/** A candidate promoted to a deal under legal hold, and the stored messages kept for it. */
export type HeldResidue = { candidateId: string; dealId: string; messages: number };

/**
 * One row of the message index handed to the bank (20261014151000_discovery_message_index_export.sql): identifiers,
 * dates, tags and versions. No subject, body or address. Ordered by (mailbox source, message key) in SQL, so the
 * purge script's fingerprint covers it.
 */
export type MessageIndexEntry = {
  /** sha256 hex of the trimmed Message-ID; the bank hashes its archive's ids the same way to match. */
  messageKey: string;
  /** Every provider id the message was read under in the mailbox (a copy has a second one). */
  providerItemIds: string[];
  sourceId: string;
  sentAt: string | null;
  dealId: string | null;
  tags: string[];
  rulesVersion: string;
  model: string | null;
  promptVersion: string | null;
  processedAt: string;
};

/** The tenant's effective retention policy (20261014160000_tenant_retention_policy.sql); pilot values when unset. */
export type RetentionPolicy = {
  lifecycle: 'pilot' | 'production' | 'decommissioning';
  contentOnDisconnect: 'delete' | 'keep';
  indexOnDisconnect: 'delete' | 'keep';
  indexAtTenantEnd: 'export_then_delete' | 'keep';
};

/** What discovery_purge_tenant returns (20261014160000_tenant_retention_policy.sql). */
export type PurgeResult = {
  runId: string;
  auditId: string;
  policy: RetentionPolicy;
  deleted: Record<string, number>;
  site: { before: Record<string, number>; after: Record<string, number> };
  heldResidue: HeldResidue[];
  /** Rows legal hold keeps, per table. */
  heldResidueCounts: Record<string, number>;
  /** Rows the retention policy keeps besides those (the message index under index_at_tenant_end keep), per table. */
  policyKeptCounts: Record<string, number>;
  /** The tenant's message index before the purge, minus rows legal hold keeps. */
  messageIndex: MessageIndexEntry[];
};

export type PurgeReport = {
  format: typeof PURGE_REPORT_FORMAT;
  tenantId: string;
  /** host[:port]/dbname of the database, never credentials. */
  target: string;
  mode: 'dry_run' | 'commit';
  startedAt: string;
  finishedAt: string;
  /**
   * The run and its discovery.tenant_purged row. A dry run's are rolled back with everything else. A commit's are
   * null until the commit's own output is read: the pending report never shows the read pass's rolled-back ids.
   */
  runId: string | null;
  auditId: string | null;
  /**
   * The purge's fingerprint: an md5 of the counts and the result without the run and audit ids. A commit needs
   * the dry run's, and refuses when the tenant's rows no longer match it.
   */
  fingerprint: string;
  policy: RetentionPolicy;
  /** Mail rows of the tenant per purged table: before, after, how many of those after legal hold keeps, and how many the retention policy keeps. */
  mail: Record<string, { before: number; after: number; held: number; kept: number }>;
  site: PurgeResult['site'];
  deleted: Record<string, number>;
  heldResidue: HeldResidue[];
  messageIndex: MessageIndexEntry[];
};

/** True when `path` is `root` or below it. Both are absolute. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The report directory, created owner-only. Refused inside any of `roots` (the
 * working tree and the main checkout), checked before the directory is created
 * and again with symlinks resolved.
 */
export function prepareReportDir(outDir: string, roots: readonly string[]): string {
  if (roots.length === 0) throw new Error('No repository root to check --out against.');
  const refuse = () =>
    new Error("--out must be outside the repository: the report describes a bank's deleted mail.");
  const target = resolve(outDir);
  if (roots.some((root) => isInside(resolve(root), target))) throw refuse();
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const real = realpathSync.native(target);
  if (roots.some((root) => isInside(realpathSync.native(root), real))) throw refuse();
  return real;
}

// A cell can hold sender-written text (a Message-ID such as <id@host>): a line break becomes a space, and what
// would end the cell or be read as HTML or an autolink is escaped, so the bank's rendered copy shows the id as it is.
// Backticks are left alone: the report writes table names as code spans.
const MARKDOWN_ESCAPES: Record<string, string> = { '\\': '\\\\', '|': '\\|', '<': '\\<', '>': '\\>', '&': '&amp;' };
export const markdownCell = (value: unknown) =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\|<>&]/g, (c) => MARKDOWN_ESCAPES[c]);
const table = (head: string[], rows: unknown[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`)];

/**
 * The Markdown report: the summary the bank's written confirmation is drafted from. A commit's `pending` report is
 * written before COMMIT and may outlive a rolled-back transaction, so it never says the rows were deleted.
 */
export function renderPurgeMarkdown(report: PurgeReport, { pending = false }: { pending?: boolean } = {}): string {
  const dryRun = report.mode === 'dry_run';
  const lines = [
    '# Tenant purge report',
    '',
    dryRun
      ? 'Dry run. The purge ran inside a transaction that was rolled back: nothing was deleted. The counts are exact.'
      : pending
        ? 'Pending: not yet confirmed. The rows below are what the commit deletes if it committed. This report is final only ' +
          'after the commit is confirmed, or after --resolve matches its discovery.tenant_purged audit row.'
        : 'Committed. The rows below were deleted.',
    '',
    ...table(['Item', 'Value'], [
      ['Tenant', report.tenantId],
      ['Database', report.target],
      ['Mode', dryRun ? 'dry run (rolled back)' : 'commit'],
      ['Started', report.startedAt],
      ['Finished', report.finishedAt],
      ['Run id', report.runId ?? 'unavailable'],
      [
        'Audit row (discovery.tenant_purged)',
        report.auditId === null ? 'unavailable' : dryRun ? `${report.auditId} (rolled back)` : report.auditId,
      ],
      ['Lifecycle', report.policy.lifecycle],
      ['Message index at tenant end', report.policy.indexAtTenantEnd === 'keep' ? 'exported and kept' : 'exported, then deleted'],
    ]),
    '',
    '## Stored mail and mail-derived data',
    '',
    'Rows of the tenant per table. After the purge only rows kept under legal hold, or kept by the retention policy,',
    'may remain.',
    ...(report.policy.indexAtTenantEnd === 'keep'
      ? ['The retention policy keeps the message index: its rows are counted as kept by the retention policy.']
      : []),
    '',
    ...table(
      ['Table', 'Before', 'After', 'Kept under legal hold', 'Kept by the retention policy'],
      Object.entries(report.mail).map(([name, c]) => [`\`${name}\``, c.before, c.after, c.held, c.kept]),
    ),
    '',
    '## Deleted',
    '',
    ...table(['Kind', 'Rows'], Object.entries(report.deleted).map(([kind, n]) => [kind, n])),
    '',
    '## SharePoint site content (kept: out of scope)',
    '',
    ...table(
      ['Count', 'Before', 'After'],
      Object.keys(report.site.before).map((key) => [key, report.site.before[key], report.site.after[key]]),
    ),
    '',
    '## Message index for the bank',
    '',
    'One row per message per mailbox Conductia processed, for matching against the bank\'s own archive. It holds',
    'identifiers (a copied message lists every provider id), dates, category tags and versions, never content.',
    '',
    ...(report.messageIndex.length === 0
      ? ['No message was indexed.']
      : table(
          ['Message-ID sha256', 'Provider ids', 'Mailbox source', 'Sent', 'Deal', 'Tags', 'Rules', 'Model', 'Prompt', 'Processed'],
          report.messageIndex.map((m) => [
            m.messageKey, m.providerItemIds.join(' '), m.sourceId, m.sentAt, m.dealId, m.tags.join(' '),
            m.rulesVersion, m.model, m.promptVersion, m.processedAt,
          ]),
        )),
    '',
    '## Legal hold',
    '',
    ...(report.heldResidue.length === 0
      ? ['Nothing is held.']
      : [
          'These candidates evidence a deal under legal hold. Their stored mail is kept until the hold is lifted,',
          'then the worker deletes it.',
          '',
          ...table(['Candidate', 'Deal', 'Stored messages kept'], report.heldResidue.map((h) => [h.candidateId, h.dealId, h.messages])),
        ]),
    '',
  ];
  return lines.join('\n');
}

export type ReportPaths = { json: string; markdown: string; pendingJson: string; pendingMarkdown: string };

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Before any database work: the destination is outside the repository, exists, is writable (a probe file is
 * created and removed) and holds none of this run's four files. Returns the paths, named
 * `<dir>/tenant-purge-<tenant>-<stamp>-<mode>[.pending].json|md`. Throws, naming the cause, when it cannot.
 */
export function reserveReportPaths(
  outDir: string,
  tenantId: string,
  stamp: string,
  mode: PurgeReport['mode'],
  roots: readonly string[],
): ReportPaths {
  const cannot = (error: unknown) =>
    new Error(`Cannot write the report to ${resolve(outDir)}: ${error instanceof Error ? error.message : String(error)}. Nothing was purged.`);
  let dir: string;
  try {
    dir = prepareReportDir(outDir, roots);
  } catch (error) {
    throw (error as NodeJS.ErrnoException).code ? cannot(error) : error;
  }
  const base = join(dir, `tenant-purge-${tenantId}-${stamp.replace(/[-:]/g, '')}-${mode === 'dry_run' ? 'dry-run' : 'commit'}`);
  const paths = {
    json: `${base}.json`,
    markdown: `${base}.md`,
    pendingJson: `${base}.pending.json`,
    pendingMarkdown: `${base}.pending.md`,
  };
  try {
    for (const path of Object.values(paths)) {
      try {
        lstatSync(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      throw new Error(`${path} already exists`);
    }
    const probe = join(dir, `.probe-${process.pid}-${Date.now()}`);
    closeSync(openSync(probe, 'wx', 0o600));
    unlinkSync(probe);
  } catch (error) {
    throw cannot(error);
  }
  return paths;
}

/** Creates `path` (exclusive), owner-only, and fsyncs it before returning; a failed write removes it. */
function writeDurable(path: string, content: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
    chmodSync(path, 0o600);
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** Removes the `.pending` files. Never throws: it runs on a failure path. */
export function discardPendingReport(paths: ReportPaths): void {
  for (const path of [paths.pendingJson, paths.pendingMarkdown]) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Writes the two `.pending` files: exclusive create, 0600, fsynced. A failed write leaves none of the files it
 * created, and never removes one it did not create.
 */
export function writePendingReport(paths: ReportPaths, report: PurgeReport): void {
  writeDurable(paths.pendingJson, `${JSON.stringify(report, null, 2)}\n`);
  try {
    writeDurable(paths.pendingMarkdown, renderPurgeMarkdown(report, { pending: report.mode === 'commit' }));
  } catch (error) {
    unlinkSync(paths.pendingJson);
    throw error;
  }
}

/**
 * Replaces the `.pending` files with `report`, the confirmed commit (its Markdown says the rows were deleted), without ever truncating them: the new content goes to fresh temp
 * files (exclusive create, 0600, fsynced), which are then renamed over the `.pending` files. If a temp file cannot
 * be written, the temps are removed and the `.pending` files are left exactly as they were.
 */
export function replacePendingReport(paths: ReportPaths, report: PurgeReport): void {
  const tag = `.tmp-${process.pid}-${Date.now()}`;
  const jsonTmp = `${paths.pendingJson}${tag}`;
  const markdownTmp = `${paths.pendingMarkdown}${tag}`;
  writeDurable(jsonTmp, `${JSON.stringify(report, null, 2)}\n`);
  try {
    writeDurable(markdownTmp, renderPurgeMarkdown(report));
  } catch (error) {
    unlinkSync(jsonTmp);
    throw error;
  }
  renameSync(jsonTmp, paths.pendingJson);
  renameSync(markdownTmp, paths.pendingMarkdown);
}

/**
 * The dry run a commit is built on: its JSON report, which must be this format, a dry run, of `tenantId`, against
 * `target`, with a fingerprint. Throws, naming the cause, before any database work.
 */
export function readDryRunReport(path: string, tenantId: string, target: string): PurgeReport {
  const refuse = (why: string) => new Error(`--from-dry-run ${path}: ${why}. Nothing was purged.`);
  let report: Partial<PurgeReport>;
  try {
    report = JSON.parse(readFileSync(path, 'utf8')) as Partial<PurgeReport>;
  } catch (error) {
    throw refuse(`cannot read a JSON report (${error instanceof Error ? error.message : String(error)})`);
  }
  if (report?.format !== PURGE_REPORT_FORMAT) throw refuse(`not a ${PURGE_REPORT_FORMAT} report`);
  if (report.mode !== 'dry_run') throw refuse('not a dry run report');
  if (report.tenantId !== tenantId) throw refuse(`it is for tenant ${String(report.tenantId)}, not ${tenantId}`);
  if (report.target !== target) throw refuse(`it ran against ${String(report.target)}, not ${target}`);
  if (typeof report.fingerprint !== 'string' || !/^[0-9a-f]{32}$/.test(report.fingerprint)) {
    throw refuse('it holds no purge fingerprint');
  }
  return report as PurgeReport;
}

/** Renames the `.pending` files to their final names. */
export function finalizeReport(paths: ReportPaths): void {
  renameSync(paths.pendingJson, paths.json);
  renameSync(paths.pendingMarkdown, paths.markdown);
}
