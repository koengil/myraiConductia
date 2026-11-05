/**
 * Deletes a tenant's stored mail and everything derived from it, at pilot end or on the bank's written
 * request (#461; owner decision 2026-10-13, Ignatious G0).
 *
 *   node --env-file=.env.<target> --import tsx scripts/discovery/purge-tenant.ts --tenant <uuid> [--out <dir>]
 *   node --env-file=.env.<target> --import tsx scripts/discovery/purge-tenant.ts --tenant <uuid> \
 *     --commit --confirm-tenant <uuid> --from-dry-run <dry run report .json> [--out <dir>]
 *   node --env-file=.env.<target> --import tsx scripts/discovery/purge-tenant.ts --tenant <uuid> \
 *     --resolve <a commit's .pending.json>
 *
 * A dry run by default. The statements run in one psql transaction:
 *   begin
 *   count the tenant's mail rows per TENANT_PURGE_TABLES table (src/lib/constants/discovery.ts)
 *   select discovery_purge_tenant(tenant, 'purge-tenant')    every mailbox source, the mail, the mail-derived
 *                                                            rows; one discovery.tenant_purged audit row
 *   count again; refuse (raise) when a table keeps a row legal hold does not explain, or when the
 *     SharePoint site rows changed
 *   print a fingerprint of the result (counts and result without the run and audit ids)
 *   rollback, or commit (see below)
 * so the dry run's counts are exact. It refuses while any reader registration of the tenant is active:
 * stop reading first (set the registration's status to disabled).
 *
 * The report (JSON and Markdown, mode 0600, outside the repository, default ~/conductia-purge-reports) holds
 * the counts, the tenant's retention policy, the message index for the bank (Message-ID hashes and provider ids, no
 * content; deleted after export unless the policy keeps it), the SharePoint site rows kept, the rows legal hold
 * keeps and those the retention policy keeps, and the audit row id, which the bank's written confirmation is drafted
 * from. This script prints counts only. A commit is built on a saved dry run (--from-dry-run, its JSON report),
 * and a durable report is a prerequisite of a commit, so with --commit the order is:
 *   1. before any database work: the dry run report is read and must be of this tenant and target, with a
 *      fingerprint; the destination is validated, created, probed for writability, and checked for an
 *      existing report of this run (any failure: nothing was touched)
 *   2. the statements above run once as a rollback (read) pass; its fingerprint must equal the dry run's,
 *      or the tenant changed since the dry run and the commit is refused
 *   3. its report is written to `.pending` files (exclusive create, 0600, fsync); if that fails, no commit
 *   4. the commit transaction runs the same statements and, before COMMIT, compares its fingerprint with
 *      the read pass's: a mismatch (the tenant's rows or its retention policy moved in between) raises and psql
 *      rolls back
 *   5. only after the commit succeeded the `.pending` files get the committed run and audit ids (written to
 *      fresh temp files renamed over them, so a failure here leaves the pre-commit report intact) and are
 *      renamed to their final names; on any failure before the commit they are deleted and nothing is purged.
 *      The pre-commit report holds no ids (null): if the commit's output cannot be read, the `.pending` files
 *      stay as they are, never finalized, and the run exits non-zero
 * A dry run takes steps 1 to 3 and 5 (its pass is the only one).
 *
 * The commit is one psql -c string, so the script cannot tell when COMMIT reached the server. A failed commit pass
 * counts as rolled back only when psql reports a server ERROR: Postgres never commits a transaction that raised
 * (a failed COMMIT rolls back). Any other failure (the connection dropped, psql was killed, its output overflowed)
 * leaves the outcome unknown: the `.pending` files stay and the run exits non-zero. `--resolve <.pending.json>`
 * then looks for the discovery.tenant_purged audit row of the tenant written at or after the report's startedAt
 * whose counts equal the report's deleted counts: on exactly one, the report is finalized with that row's id and
 * run id; on none or several it refuses, and the operator escalates.
 *
 * Operator-only: it connects with DATABASE_URL from the environment (a postgres role, psql 15 or later),
 * prints the target (host[:port]/dbname), and is never reached by a request, the worker or an agent. SharePoint site
 * content is out of G0's scope and survives; mailbox consents survive as the record of who opted in.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TENANT_PURGE_TABLES } from '../../src/lib/constants/discovery';
import { repoRoots } from '../discovery-export';
import { runPsql } from '../lib/schemaCatalog';
import {
  PURGE_REPORT_FORMAT,
  discardPendingReport,
  finalizeReport,
  readDryRunReport,
  replacePendingReport,
  reserveReportPaths,
  writePendingReport,
  type PurgeReport,
  type ReportPaths,
  type PurgeResult,
} from './lib/purgeReport';

export type Args = { tenant: string; commit: boolean; outDir: string; fromDryRun?: string; resolve?: string };

/** One psql run: rows of tab-separated fields. `target` names the database for the operator, never credentials. */
export type PsqlRunner = { target: string; query: (sql: string) => string[][] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_OUT_DIR = join(homedir(), 'conductia-purge-reports');
const ACTOR = 'purge-tenant';
const COUNTS = 'PURGE_COUNTS';
const RESULT = 'PURGE_RESULT';
const FINGERPRINT = 'PURGE_FP';
const FP = /^[0-9a-f]{32}$/;

function valueOf(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function parseArgs(argv: string[]): Args {
  const tenant = valueOf(argv, '--tenant')?.trim().toLowerCase();
  if (!tenant || !UUID.test(tenant)) throw new Error('--tenant <tenant uuid> is required');
  if (argv.includes('--resolve')) {
    const resolve = valueOf(argv, '--resolve')?.trim();
    if (!resolve?.endsWith('.pending.json')) throw new Error("--resolve <a commit's .pending.json report> is required");
    if (['--commit', '--confirm-tenant', '--from-dry-run', '--out'].some((flag) => argv.includes(flag))) {
      throw new Error('--resolve only settles a pending commit report: drop --commit, --confirm-tenant, --from-dry-run and --out');
    }
    return { tenant, commit: false, outDir: DEFAULT_OUT_DIR, resolve };
  }
  const commit = argv.includes('--commit');
  const confirm = valueOf(argv, '--confirm-tenant')?.trim().toLowerCase();
  if (commit && confirm !== tenant) {
    throw new Error('--commit deletes for good: it needs --confirm-tenant <the same tenant uuid as --tenant>');
  }
  if (!commit && confirm !== undefined) {
    throw new Error('--confirm-tenant only confirms --commit: add --commit, or drop it for a dry run');
  }
  const fromDryRun = valueOf(argv, '--from-dry-run')?.trim();
  if (commit && !fromDryRun) {
    throw new Error('--commit deletes for good: it needs --from-dry-run <the JSON report of a dry run of this tenant>');
  }
  if (!commit && argv.includes('--from-dry-run')) {
    throw new Error('--from-dry-run only backs --commit: add --commit, or drop it for a dry run');
  }
  const outDir = valueOf(argv, '--out')?.trim();
  if (argv.includes('--out') && !outDir) throw new Error('--out <dir> needs a directory');
  return { tenant, commit, outDir: outDir || DEFAULT_OUT_DIR, ...(fromDryRun ? { fromDryRun } : {}) };
}

/** The tenant's rows per purged table, from the one map the classification test pins. */
function countStatement(phase: 'before' | 'after', tenantLiteral: string): string {
  const selects = Object.entries(TENANT_PURGE_TABLES).map(
    ([name, predicate]) =>
      `select '${phase}', '${name}', count(*) from ${name} t where ${predicate.replaceAll(":'tenant'", tenantLiteral)}`,
  );
  return `insert into purge_counts (phase, tbl, n)\n${selects.join('\nunion all\n')};`;
}

/**
 * The whole transaction. The tenant is a validated uuid, inlined as a literal: psql does not interpolate
 * variables in a -c string. Any raise aborts the rest, so nothing after a failed check commits.
 *
 * `commit` needs `expectedFingerprint`, the read pass's: the transaction raises before COMMIT when its own
 * differs. The fingerprint is an md5 of the counts and the result without runId and auditId (fresh uuids each
 * run), as jsonb text: jsonb orders its keys, and the result's arrays are ordered in discovery_purge_tenant:
 * heldResidue by candidate id, messageIndex by (content_source_id, message_key). The message index is part of
 * the fingerprint, so a commit whose export differs from the report already on disk rolls back. So is the
 * retention policy (lifecycle and the three choices, built from the policy row's columns only: no timestamp, no
 * writer), so a policy changed between the read pass and the commit also rolls back, and so are heldResidueCounts
 * and policyKeptCounts (part of the result), so the kept rows the check accepts are the ones the dry run reported.
 */
export function purgeSql(tenant: string, commit: boolean, expectedFingerprint?: string): string {
  if (!UUID.test(tenant)) throw new Error('purgeSql: tenant must be a uuid');
  if (commit && !FP.test(expectedFingerprint ?? '')) throw new Error('purgeSql: a commit needs the read pass fingerprint');
  const t = `'${tenant}'`;
  return [
    'begin;',
    'create temp table purge_counts (phase text, tbl text, n bigint) on commit drop;',
    countStatement('before', t),
    `create temp table purge_result on commit drop as select discovery_purge_tenant(${t}::uuid, '${ACTOR}') as r;`,
    countStatement('after', t),
    `do $check$
declare
  v_bad text;
begin
  select string_agg(c.tbl || ': ' || c.n || ' left, ' || coalesce(p.r->'heldResidueCounts'->>c.tbl, '0') || ' held, '
                    || coalesce(p.r->'policyKeptCounts'->>c.tbl, '0') || ' kept by policy', '; ' order by c.tbl)
    into v_bad
  from purge_counts c cross join purge_result p
  where c.phase = 'after'
    and c.n <> coalesce((p.r->'heldResidueCounts'->>c.tbl)::bigint, 0)
               + coalesce((p.r->'policyKeptCounts'->>c.tbl)::bigint, 0);
  if v_bad is not null then
    raise exception 'purge_incomplete: mail rows remain that legal hold and the retention policy do not explain: %', v_bad;
  end if;
  if exists (select 1 from purge_result p where p.r->'site'->'before' is distinct from p.r->'site'->'after') then
    raise exception 'site_changed: SharePoint site rows changed: %', (select p.r->'site' from purge_result p);
  end if;
end
$check$;`,
    `create temp table purge_fp on commit drop as select md5(jsonb_build_object(
  'counts', (select jsonb_object_agg(tbl, jsonb_build_object('before', b, 'after', a)) from (
    select tbl, max(n) filter (where phase = 'before') as b, max(n) filter (where phase = 'after') as a
    from purge_counts group by tbl) x),
  'result', r - 'runId' - 'auditId')::text) as fp from purge_result;`,
    ...(commit
      ? [
          `do $fp$
begin
  if (select fp from purge_fp) is distinct from '${expectedFingerprint}' then
    raise exception 'fingerprint_mismatch: the tenant changed since the report was written: expected ${expectedFingerprint}, got %', (select fp from purge_fp);
  end if;
end
$fp$;`,
        ]
      : []),
    `select '${FINGERPRINT}', fp from purge_fp;`,
    `select '${COUNTS}', json_object_agg(tbl, json_build_object('before', b, 'after', a)) from (
  select tbl, max(n) filter (where phase = 'before') as b, max(n) filter (where phase = 'after') as a
  from purge_counts group by tbl) x;`,
    `select '${RESULT}', r::text from purge_result;`,
    commit ? 'commit;' : 'rollback;',
  ].join('\n');
}

/** The two marked rows of the transaction's output. psql before 15 prints only the last result: refuse it. */
export function parsePurgeOutput(rows: string[][]): {
  counts: Record<string, { before: number; after: number }>;
  result: PurgeResult;
  fingerprint: string;
} {
  const text = (marker: string) => {
    const row = rows.find((fields) => fields[0] === marker);
    if (!row) {
      throw new Error(`psql printed no ${marker} row. The purge needs psql 15 or later, which prints every result.`);
    }
    return row.slice(1).join('\t');
  };
  const marked = (marker: string) => JSON.parse(text(marker)) as unknown;
  return {
    counts: marked(COUNTS) as Record<string, { before: number; after: number }>,
    result: marked(RESULT) as PurgeResult,
    fingerprint: text(FINGERPRINT),
  };
}

/**
 * The database a DATABASE_URL names, as host[:port]/dbname: never the user, password or query. A dry run report
 * is matched to a commit by it, so two databases on one host never pass for each other. Throws, without the
 * URL, when the host or the database name is missing.
 */
export function targetOf(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // `new URL` puts the whole input on the error it throws. Do not rethrow it.
    throw new Error('DATABASE_URL cannot be parsed: the purge needs postgresql://host[:port]/dbname');
  }
  const name = url.pathname.replace(/^\//, '');
  if (!url.host || !name || name.includes('/')) {
    throw new Error('DATABASE_URL must name a host and a database (postgresql://host[:port]/dbname)');
  }
  return `${url.host}/${name}`;
}

function defaultRunner(): PsqlRunner {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL must be set (node --env-file=.env.<target>): the purge runs through psql');
  return { target: targetOf(url), query: (sql) => runPsql(url, sql) };
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** The report of one pass: the committed run's ids replace the read pass's in a commit's final report. */
function buildReport(
  args: Args,
  target: string,
  startedAt: string,
  parsed: ReturnType<typeof parsePurgeOutput>,
): PurgeReport {
  const { counts, result, fingerprint } = parsed;
  return {
    format: PURGE_REPORT_FORMAT,
    tenantId: args.tenant,
    target,
    mode: args.commit ? 'commit' : 'dry_run',
    startedAt,
    finishedAt: new Date().toISOString(),
    runId: result.runId,
    auditId: result.auditId,
    policy: result.policy,
    fingerprint,
    mail: Object.fromEntries(
      Object.keys(TENANT_PURGE_TABLES).map((name) => [
        name,
        {
          before: counts[name]?.before ?? 0,
          after: counts[name]?.after ?? 0,
          held: result.heldResidueCounts[name] ?? 0,
          kept: result.policyKeptCounts[name] ?? 0,
        },
      ]),
    ),
    site: result.site,
    deleted: result.deleted,
    heldResidue: result.heldResidue,
    messageIndex: result.messageIndex,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What a failed commit pass did. `rolled_back` only when psql reports a server ERROR: the transaction raised, and
 * Postgres never commits a transaction that raised (a failed COMMIT rolls back). Anything else, a dropped
 * connection, a killed or overflowing psql, is `unknown`: COMMIT may have reached the server.
 */
export function commitPassOutcome(error: unknown): 'rolled_back' | 'unknown' {
  return /(^|\s)ERROR:\s/.test(message(error)) ? 'rolled_back' : 'unknown';
}

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * `--resolve`: settles a commit whose outcome is unknown from its `.pending.json`. The commit happened if, and only
 * if, its discovery.tenant_purged row exists (the purge writes it in the same transaction). Exactly one row of the
 * tenant, written at or after the report's startedAt, with counts equal to the report's deleted counts, finalizes
 * the report with its ids; none or several refuse.
 */
function resolvePending(args: Args, db: PsqlRunner, log: (line: string) => void): number {
  const pendingJson = args.resolve ?? '';
  const base = pendingJson.slice(0, -'.pending.json'.length);
  const paths: ReportPaths = { json: `${base}.json`, markdown: `${base}.md`, pendingJson, pendingMarkdown: `${base}.pending.md` };
  let report: PurgeReport;
  try {
    report = JSON.parse(readFileSync(pendingJson, 'utf8')) as PurgeReport;
  } catch (error) {
    log(`refused: cannot read ${pendingJson}: ${message(error)}`);
    return 1;
  }
  const why =
    report?.format !== PURGE_REPORT_FORMAT ? `not a ${PURGE_REPORT_FORMAT} report`
    : report.mode !== 'commit' ? 'not a commit report'
    : report.tenantId !== args.tenant ? `it is for tenant ${String(report.tenantId)}, not ${args.tenant}`
    : report.target !== db.target ? `it ran against ${String(report.target)}, not ${db.target}`
    : report.runId !== null || report.auditId !== null ? 'it already holds the committed ids'
    : Number.isNaN(Date.parse(report.startedAt)) ? 'it holds no start time'
    : !report.deleted || Object.values(report.deleted).some((n) => !Number.isInteger(n)) ? 'it holds no deleted counts'
    : [paths.json, paths.markdown].some((path) => existsSync(path)) ? 'its final report already exists'
    : !existsSync(paths.pendingMarkdown) ? `${paths.pendingMarkdown} is missing`
    : undefined;
  if (why) {
    log(`refused: ${pendingJson}: ${why}.`);
    return 1;
  }
  log(`Target: ${db.target}, tenant ${args.tenant}, resolving the commit started ${report.startedAt}`);
  // startedAt is this machine's clock, the audit ts the database's. Five minutes absorb ordinary skew (a clock
  // ahead would otherwise miss the row and refuse); the exact deleted counts and the one-match rule still decide.
  const rows = db
    .query(
      `select 'AUDIT', id, detail->>'runId' from audit_log
where tenant_id = ${quote(args.tenant)}::uuid and action = 'discovery.tenant_purged'
  and ts >= ${quote(report.startedAt)}::timestamptz - interval '5 minutes'
  and (detail - 'runId') = ${quote(JSON.stringify(report.deleted))}::jsonb
order by ts;`,
    )
    .filter((fields) => fields[0] === 'AUDIT');
  if (rows.length !== 1 || !rows[0][1] || !rows[0][2]) {
    log(
      `refused: ${rows.length} discovery.tenant_purged audit rows of the tenant since ${report.startedAt} match the report's deleted counts; exactly one settles it.`,
    );
    log(`The outcome stays unknown. Escalate, and do not purge this tenant again until it is settled. The pending report is intact: ${pendingJson}`);
    return 1;
  }
  const [, auditId, runId] = rows[0];
  try {
    replacePendingReport(paths, { ...report, runId, auditId });
    finalizeReport(paths);
  } catch (error) {
    log(`Committed (audit row ${auditId}, run ${runId}), but the report could not be finalized: ${message(error)}`);
    log(`The pending report: ${pendingJson}`);
    return 1;
  }
  log(`Report: ${paths.markdown}`);
  log(`        ${paths.json}`);
  log(`Committed. Audit row ${auditId} (discovery.tenant_purged).`);
  return 0;
}

export async function run(
  argv: string[],
  runner?: PsqlRunner,
  log: (line: string) => void = console.log,
  roots: () => readonly string[] = () => repoRoots(SCRIPT_DIR),
): Promise<number> {
  const args = parseArgs(argv);
  const db = runner ?? defaultRunner();
  if (args.resolve) return resolvePending(args, db, log);
  const startedAt = new Date().toISOString();
  // Before any database work: a commit without a matching dry run, or an unusable destination, stops the run
  // here, with nothing touched.
  const dryRun = args.commit ? readDryRunReport(args.fromDryRun ?? '', args.tenant, db.target) : undefined;
  const paths = reserveReportPaths(args.outDir, args.tenant, startedAt, args.commit ? 'commit' : 'dry_run', roots());
  log(`Target: ${db.target}, tenant ${args.tenant}, ${args.commit ? 'COMMIT: deletes for good' : 'dry run: rolls back'}`);

  const active = db.query(
    `select 'ACTIVE', reader_registration_active('${args.tenant}'::uuid, 'microsoft') or reader_registration_active('${args.tenant}'::uuid, 'google');`,
  );
  const flag = active.find((fields) => fields[0] === 'ACTIVE')?.[1];
  if (flag !== 'f') {
    log(
      flag === 't'
        ? 'refused: a reader registration of the tenant is active. Stop reading first: set its status to disabled.'
        : 'refused: could not tell whether a reader registration of the tenant is active.',
    );
    return 1;
  }

  // The read pass: a dry run's only pass, and a commit's rehearsal. Always rolled back.
  let parsed: ReturnType<typeof parsePurgeOutput>;
  try {
    parsed = parsePurgeOutput(db.query(purgeSql(args.tenant, false)));
  } catch (error) {
    log(`refused: ${message(error)}`);
    log('Nothing was committed.');
    return 1;
  }
  if (dryRun && parsed.fingerprint !== dryRun.fingerprint) {
    log('refused: the tenant changed since the dry run: its rows no longer match the dry run report. Run a new dry run.');
    log('Nothing was committed.');
    return 1;
  }
  // A commit's pending report carries no ids: the read pass's were rolled back, the commit's are not known yet.
  let report = buildReport(args, db.target, startedAt, parsed);
  if (args.commit) report = { ...report, runId: null, auditId: null };

  // The report is durable before anything is committed: if it cannot be written, the commit never runs.
  try {
    writePendingReport(paths, report);
  } catch (error) {
    log(`refused: the report could not be written: ${message(error)}`);
    log(args.commit ? 'Nothing was committed.' : 'Nothing was written.');
    return 1;
  }

  if (args.commit) {
    let output: string[][];
    try {
      output = db.query(purgeSql(args.tenant, true, parsed.fingerprint));
    } catch (error) {
      if (commitPassOutcome(error) === 'unknown') {
        log(`OUTCOME UNKNOWN: the commit pass failed after it may have reached the server: ${message(error)}`);
        log(`The purge may have committed. The pending report is kept, with the counts the commit would delete: ${paths.pendingJson}`);
        log(`Do not purge this tenant again. Settle it: --tenant ${args.tenant} --resolve ${paths.pendingJson}`);
        return 1;
      }
      discardPendingReport(paths);
      log(`refused: ${message(error)}`);
      log('Nothing was committed.');
      return 1;
    }
    try {
      // The committed run has its own run and audit ids (the read pass's were rolled back with it).
      report = buildReport(args, db.target, startedAt, parsePurgeOutput(output));
    } catch (error) {
      log(`Committed, but its output could not be read: ${message(error)}. Find the discovery.tenant_purged audit row.`);
      log(`The pending report is intact and holds the read pass's counts, which the commit matched: ${paths.pendingJson}.`);
      log(`Settle it: --tenant ${args.tenant} --resolve ${paths.pendingJson}`);
      return 1;
    }
    try {
      replacePendingReport(paths, report);
    } catch (error) {
      log(`Committed, but the report could not be updated with the committed ids: ${message(error)}`);
      log(
        `The pending report is intact and holds the read pass's counts, which the commit matched: ${paths.pendingJson}. ` +
          `Audit row ${report.auditId} (discovery.tenant_purged) has the committed run's ids.`,
      );
      return 1;
    }
  }
  try {
    finalizeReport(paths);
  } catch (error) {
    log(`${args.commit ? 'Committed, but the' : 'The'} report could not be finalized: ${message(error)}`);
    log(`The pending report: ${paths.pendingJson}${args.commit ? `. Audit row ${report.auditId} (discovery.tenant_purged).` : ''}`);
    return 1;
  }

  for (const [name, c] of Object.entries(report.mail)) {
    log(`  ${name}: ${c.before} -> ${c.after}${c.held ? ` (${c.held} held)` : ''}${c.kept ? ` (${c.kept} kept by policy)` : ''}`);
  }
  log(`Deleted: ${Object.entries(report.deleted).map(([kind, n]) => `${kind} ${n}`).join(', ')}`);
  log(`SharePoint site rows unchanged: ${Object.entries(report.site.after).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  log(`Retention policy: ${report.policy.lifecycle}, message index at tenant end ${report.policy.indexAtTenantEnd}.`);
  log(`Message index for the bank: ${report.messageIndex.length} row(s).`);
  log(`Held under legal hold: ${report.heldResidue.length} candidate(s).`);
  log(`Report: ${paths.markdown}`);
  log(`        ${paths.json}`);
  if (args.commit) {
    log(`Committed. Audit row ${report.auditId} (discovery.tenant_purged).`);
  } else {
    log(`Dry run: rolled back, nothing deleted. To delete: --commit --confirm-tenant ${args.tenant} --from-dry-run ${paths.json}`);
  }
  return 0;
}

if (process.argv[1]?.endsWith('purge-tenant.ts')) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
