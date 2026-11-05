// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TENANT_PURGE_TABLES } from '@/lib/constants/discovery';

import {
  DEFAULT_OUT_DIR,
  commitPassOutcome,
  parseArgs,
  parsePurgeOutput,
  purgeSql,
  run,
  targetOf,
  type PsqlRunner,
} from '../../scripts/discovery/purge-tenant';
import { markdownCell, PURGE_REPORT_FORMAT, prepareReportDir, type PurgeResult } from '../../scripts/discovery/lib/purgeReport';

/**
 * The tenant purge operator script (#461 slice 3), against an injected psql runner. The SQL itself is
 * proven by supabase/tests/discovery_tenant_purge.sql (tests/db/discovery-tenant-purge.test.ts).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REPO = process.cwd();

const RESULT: PurgeResult = {
  runId: 'run-1',
  auditId: 'audit-1',
  policy: { lifecycle: 'decommissioning', contentOnDisconnect: 'delete', indexOnDisconnect: 'delete', indexAtTenantEnd: 'keep' },
  deleted: { sources: 2, items: 4, candidates: 1, heldSkipped: 1 },
  site: { before: { siteSources: 1, documents: 3 }, after: { siteSources: 1, documents: 3 } },
  heldResidue: [{ candidateId: 'cand-h', dealId: 'deal-h', messages: 1 }],
  heldResidueCounts: { source_items: 1, source_item_texts: 1 },
  policyKeptCounts: { discovery_message_index: 1 },
  messageIndex: [
    {
      messageKey: '1604d28ce6c9c71520c827b85e9af7f6f7b93fb7dd7c6dc007f9569a857d86c0',
      providerItemIds: ['p-1', 'p-2'],
      sourceId: 'src-1',
      sentAt: '2026-03-02T00:00:00+00:00',
      dealId: 'deal-1',
      tags: ['mnpi', 'promissory'],
      rulesVersion: 'rules-x',
      model: null,
      promptVersion: null,
      processedAt: '2026-10-14T10:00:00+00:00',
    },
  ],
};

const COUNTS = Object.fromEntries(
  Object.keys(TENANT_PURGE_TABLES).map((name) => [
    name,
    { before: 5, after: ['source_items', 'source_item_texts', 'discovery_message_index'].includes(name) ? 1 : 0 },
  ]),
);

const FP = 'a'.repeat(32);

/**
 * A fake psql: answers the registration check, then the purge transactions. Records every statement.
 * `onPurge(n, statement)` runs before the n-th purge statement answers (0 is the read pass, 1 the commit) and
 * may throw to fail it.
 */
function fakeRunner(opts: { active?: 't' | 'f' | ''; purge?: string[][] | Error; onPurge?: (n: number, statement: string) => void } = {}) {
  const sql: string[] = [];
  let purges = 0;
  const runner: PsqlRunner = {
    target: '127.0.0.1:54322/postgres',
    query: (statement) => {
      sql.push(statement);
      if (statement.includes("'ACTIVE'")) return opts.active === '' ? [] : [['ACTIVE', opts.active ?? 'f']];
      opts.onPurge?.(purges++, statement);
      if (opts.purge instanceof Error) throw opts.purge;
      return (
        opts.purge ?? [
          ['BEGIN'],
          ['PURGE_FP', FP],
          ['PURGE_COUNTS', JSON.stringify(COUNTS)],
          ['PURGE_RESULT', JSON.stringify(RESULT)],
          [statement.trimEnd().endsWith('commit;') ? 'COMMIT' : 'ROLLBACK'],
        ]
      );
    },
  };
  return { runner, sql };
}

const purgeStatements = (sql: string[]) => sql.filter((statement) => !statement.includes("'ACTIVE'"));

/** A saved dry run report of TENANT against the fake runner's target, in its own directory. */
function dryRunReport(overrides: Record<string, unknown> = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'purge-dry-run-')), 'dry-run.json');
  const report = { format: PURGE_REPORT_FORMAT, tenantId: TENANT, target: '127.0.0.1:54322/postgres', mode: 'dry_run', fingerprint: FP };
  writeFileSync(path, JSON.stringify({ ...report, ...overrides }));
  return path;
}
const commitArgv = (dir: string, dryRun = dryRunReport()) =>
  ['--tenant', TENANT, '--commit', '--confirm-tenant', TENANT, '--from-dry-run', dryRun, '--out', dir];

const scratch: string[] = [];
const outDir = () => {
  const root = mkdtempSync(join(tmpdir(), 'purge-report-'));
  scratch.push(root);
  return join(root, 'reports');
};
afterEach(() => {
  for (const root of scratch.splice(0)) {
    try {
      chmodSync(join(root, 'reports'), 0o700);
    } catch {
      // Never created.
    }
  }
});

describe('the tenant purge operator script', () => {
  it('needs a tenant uuid, and --commit only with a --confirm-tenant equal to it and a dry run report', () => {
    expect(() => parseArgs([])).toThrow('--tenant');
    expect(() => parseArgs(['--tenant', 'acme'])).toThrow('--tenant');
    expect(() => parseArgs(['--tenant', TENANT, '--commit'])).toThrow('--confirm-tenant');
    expect(() => parseArgs(['--tenant', TENANT, '--commit', '--confirm-tenant', OTHER])).toThrow('--confirm-tenant');
    expect(() => parseArgs(['--tenant', TENANT, '--confirm-tenant', TENANT])).toThrow('--commit');
    expect(() => parseArgs(['--tenant', TENANT, '--commit', '--confirm-tenant', TENANT])).toThrow('--from-dry-run');
    expect(() => parseArgs(['--tenant', TENANT, '--commit', '--confirm-tenant', TENANT, '--from-dry-run'])).toThrow('--from-dry-run');
    expect(() => parseArgs(['--tenant', TENANT, '--from-dry-run', '/d.json'])).toThrow('--commit');
    expect(() => parseArgs(['--tenant', TENANT, '--resolve', '/r.json'])).toThrow('.pending.json');
    expect(() => parseArgs(['--tenant', TENANT, '--resolve', '/r.pending.json', '--commit'])).toThrow('--resolve only');
    expect(parseArgs(['--tenant', TENANT, '--resolve', '/r.pending.json'])).toMatchObject({ resolve: '/r.pending.json', commit: false });
    expect(parseArgs(['--tenant', TENANT])).toEqual({ tenant: TENANT, commit: false, outDir: DEFAULT_OUT_DIR });
    expect(
      parseArgs(['--tenant', TENANT.toUpperCase(), '--commit', '--confirm-tenant', TENANT, '--from-dry-run', '/d.json', '--out', '/r']),
    ).toEqual({ tenant: TENANT, commit: true, outDir: '/r', fromDryRun: '/d.json' });
  });

  it('refuses --commit without a matching --confirm-tenant before touching the database', async () => {
    const { runner, sql } = fakeRunner();
    await expect(run(['--tenant', TENANT, '--commit', '--confirm-tenant', OTHER], runner, () => {})).rejects.toThrow('--confirm-tenant');
    expect(sql).toEqual([]);
  });

  it('refuses --commit without a saved dry run of this tenant and target, before touching the database', async () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'purge-dry-run-')), 'none.json');
    const notJson = dryRunReport();
    writeFileSync(notJson, 'not json');
    const refusals: Array<[string, string]> = [
      [missing, 'cannot read'],
      [notJson, 'cannot read'],
      [dryRunReport({ format: 'other/v1' }), 'not a conductia.tenant-purge-report/v1 report'],
      [dryRunReport({ mode: 'commit' }), 'not a dry run report'],
      [dryRunReport({ tenantId: OTHER }), `for tenant ${OTHER}`],
      [dryRunReport({ target: 'db.example:5432/postgres' }), 'ran against db.example:5432/postgres'],
      // Same host and port, another database.
      [dryRunReport({ target: '127.0.0.1:54322/staging' }), 'ran against 127.0.0.1:54322/staging'],
      [dryRunReport({ fingerprint: undefined }), 'no purge fingerprint'],
      [dryRunReport({ fingerprint: "x'; drop table users; --" }), 'no purge fingerprint'],
    ];
    for (const [path, why] of refusals) {
      const { runner, sql } = fakeRunner();
      const dir = outDir();
      await expect(run(commitArgv(dir, path), runner, () => {}), why).rejects.toThrow(why);
      expect(sql).toEqual([]);
    }
  });

  it('commits from the JSON report a dry run of this script wrote', async () => {
    const dryDir = outDir();
    const lines: string[] = [];
    expect(await run(['--tenant', TENANT, '--out', dryDir], fakeRunner().runner, (l) => lines.push(l))).toBe(0);
    const saved = lines.at(-1)?.split('--from-dry-run ')[1] ?? '';
    expect(saved.startsWith(dryDir.replace(/\/reports$/, ''))).toBe(true);
    const { runner, sql } = fakeRunner();
    expect(await run(commitArgv(outDir(), saved), runner, () => {})).toBe(0);
    expect(sql.some((statement) => statement.trimEnd().endsWith('commit;'))).toBe(true);
  });

  it('names the target by host, port and database, never the user, password or query', () => {
    expect(targetOf('postgresql://postgres:SECRETPW@db.example:6543/postgres?sslmode=require')).toBe('db.example:6543/postgres');
    expect(targetOf('postgresql://u:p@db.example/staging')).toBe('db.example/staging');
    expect(targetOf('postgresql://u:p@db.example:6543/postgres')).not.toBe(targetOf('postgresql://u:p@db.example:6543/staging'));
    for (const bad of ['postgresql://u:SECRETPW@db.example:6543', 'postgresql://u:SECRETPW@db.example:6543/', 'not a url SECRETPW']) {
      expect(() => targetOf(bad)).toThrow('DATABASE_URL');
      try {
        targetOf(bad);
      } catch (error) {
        expect(String(error)).not.toContain('SECRETPW');
      }
    }
  });

  it('refuses --commit when the tenant changed since the dry run: no commit, no report', async () => {
    const { runner, sql } = fakeRunner();
    const dir = outDir();
    const lines: string[] = [];
    expect(await run(commitArgv(dir, dryRunReport({ fingerprint: 'b'.repeat(32) })), runner, (l) => lines.push(l))).toBe(1);
    // Only the read pass ran.
    expect(purgeStatements(sql)).toHaveLength(1);
    expect(sql.some((statement) => statement.trimEnd().endsWith('commit;'))).toBe(false);
    expect(lines.some((line) => line.includes('changed since the dry run'))).toBe(true);
    expect(lines).toContain('Nothing was committed.');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses while a reader registration of the tenant is active, and runs no purge', async () => {
    for (const active of ['t', ''] as const) {
      const { runner, sql } = fakeRunner({ active });
      const lines: string[] = [];
      expect(await run(['--tenant', TENANT, '--out', outDir()], runner, (line) => lines.push(line))).toBe(1);
      expect(sql).toHaveLength(1);
      expect(sql[0]).toContain(`reader_registration_active('${TENANT}'::uuid, 'microsoft')`);
      expect(sql[0]).toContain(`reader_registration_active('${TENANT}'::uuid, 'google')`);
      expect(lines.some((line) => line.startsWith('refused:'))).toBe(true);
    }
  });

  it('prints the target host and rolls back by default', async () => {
    const { runner, sql } = fakeRunner();
    const lines: string[] = [];
    expect(await run(['--tenant', TENANT, '--out', outDir()], runner, (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toBe(`Target: 127.0.0.1:54322/postgres, tenant ${TENANT}, dry run: rolls back`);
    const purge = sql[1];
    expect(purge.startsWith('begin;')).toBe(true);
    expect(purge.trimEnd().endsWith('rollback;')).toBe(true);
    expect(purge).not.toContain('commit;');
    expect(purge).toContain(`discovery_purge_tenant('${TENANT}'::uuid, 'purge-tenant')`);
    expect(lines.at(-1)).toContain('Dry run: rolled back, nothing deleted');
    expect(lines.at(-1)).toMatch(/--from-dry-run \S+-dry-run\.json$/);
  });

  it('commits only with --commit and the matching confirmation, after a rollback pass, passing its fingerprint', async () => {
    const { runner, sql } = fakeRunner();
    const lines: string[] = [];
    expect(await run(commitArgv(outDir()), runner, (l) => lines.push(l))).toBe(0);
    const [read, commit] = purgeStatements(sql);
    expect(read.trimEnd().endsWith('rollback;')).toBe(true);
    expect(read).not.toContain('fingerprint_mismatch');
    expect(commit.trimEnd().endsWith('commit;')).toBe(true);
    expect(commit).not.toContain('rollback;');
    expect(commit).toContain(`is distinct from '${FP}'`);
    expect(commit.indexOf('fingerprint_mismatch')).toBeLessThan(commit.indexOf('commit;'));
    expect(lines[0]).toContain('COMMIT: deletes for good');
    expect(lines.at(-1)).toBe('Committed. Audit row audit-1 (discovery.tenant_purged).');
  });

  it.skipIf(process.getuid?.() === 0)('fails before any database work when --out is not writable, so nothing is purged', async () => {
    const readOnly = outDir();
    mkdirSync(readOnly, { mode: 0o500 });
    chmodSync(readOnly, 0o500);
    const file = join(mkdtempSync(join(tmpdir(), 'purge-file-')), 'a-file');
    writeFileSync(file, 'x');
    for (const out of [join(readOnly, 'reports'), readOnly, join(file, 'reports')]) {
      const { runner, sql } = fakeRunner();
      await expect(run(commitArgv(out), runner, () => {})).rejects.toThrow('Nothing was purged');
      expect(sql).toEqual([]);
    }
  });

  describe('with the clock pinned, so the report names are known', () => {
    const base = (dir: string) => join(dir, `tenant-purge-${TENANT}-20261015T100000.000Z-commit`);
    const pin = () => vi.useFakeTimers({ now: new Date('2026-10-15T10:00:00.000Z'), toFake: ['Date'] });
    afterEach(() => vi.useRealTimers());

    it('fails before any database work when a report file of the run already exists', async () => {
      pin();
      const dir = outDir();
      mkdirSync(dir);
      for (const taken of ['.json', '.md', '.pending.json', '.pending.md']) {
        writeFileSync(`${base(dir)}${taken}`, 'old');
        const { runner, sql } = fakeRunner();
        await expect(run(commitArgv(dir), runner, () => {})).rejects.toThrow('already exists');
        expect(sql).toEqual([]);
        rmSync(`${base(dir)}${taken}`);
      }
      expect(readdirSync(dir)).toEqual([]);
    });

    it('stops the commit when the pending report cannot be written, and leaves no report', async () => {
      pin();
      const dir = outDir();
      const lines: string[] = [];
      const { runner, sql } = fakeRunner({
        // Another process takes the pending name between the checks and the write.
        onPurge: (n) => n === 0 && writeFileSync(`${base(dir)}.pending.md`, 'not ours'),
      });
      expect(await run(commitArgv(dir), runner, (l) => lines.push(l))).toBe(1);
      // The read pass ran, the commit never did.
      expect(purgeStatements(sql)).toHaveLength(1);
      expect(sql.some((statement) => statement.trimEnd().endsWith('commit;'))).toBe(false);
      expect(lines).toContain('Nothing was committed.');
      // Only the file that was not ours is left: no final report, and the first pending file is gone.
      expect(readdirSync(dir)).toEqual([`${base(dir).split('/').pop()}.pending.md`]);
    });

    it('has the message index in the pending report before the commit runs, and in the fingerprinted result', async () => {
      pin();
      const dir = outDir();
      let pending: { json: string; md: string } | undefined;
      const { runner } = fakeRunner({
        onPurge: (n) => {
          if (n !== 1) return;
          const name = `${base(dir)}.pending`;
          pending = { json: readFileSync(`${name}.json`, 'utf8'), md: readFileSync(`${name}.md`, 'utf8') };
        },
      });
      expect(await run(commitArgv(dir), runner, () => {})).toBe(0);
      // On disk, durable, before the commit statement ran: the rows the bank is handed.
      expect(pending).toBeDefined();
      expect(JSON.parse(pending!.json).messageIndex).toEqual(RESULT.messageIndex);
      expect(pending!.md).toContain('## Message index for the bank');
      expect(pending!.md).toContain('1604d28ce6c9c71520c827b85e9af7f6f7b93fb7dd7c6dc007f9569a857d86c0 | p-1 p-2 | src-1');
      // The fingerprint covers the whole result, so the index is in it and a commit that exports different
      // rows than the report on disk raises before COMMIT (discovery_purge_tenant orders the index by
      // content_source_id, message_key so the same rows give the same fingerprint).
      const sql = purgeSql(TENANT, true, FP);
      expect(sql).toContain("'result', r - 'runId' - 'auditId'");
      expect(sql.indexOf('fingerprint_mismatch')).toBeLessThan(sql.indexOf('commit;'));
    });

    it('rolls back on a fingerprint mismatch: no final report, no pending file, non-zero exit', async () => {
      pin();
      const dir = outDir();
      const lines: string[] = [];
      const { runner, sql } = fakeRunner({
        onPurge: (n) => {
          if (n === 1) throw new Error('psql failed against 127.0.0.1:54322 (exit 3): ERROR:  fingerprint_mismatch: the tenant changed');
        },
      });
      expect(await run(commitArgv(dir), runner, (l) => lines.push(l))).toBe(1);
      expect(purgeStatements(sql)).toHaveLength(2);
      expect(lines).toContain('Nothing was committed.');
      expect(lines.some((line) => line.includes('fingerprint_mismatch'))).toBe(true);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('keeps the pre-commit report intact when the post-commit rewrite fails', async () => {
      pin();
      const dir = outDir();
      const lines: string[] = [];
      // The post-commit rewrite goes to a fresh temp file (exclusive create); taking its name makes it fail.
      const { runner } = fakeRunner({
        onPurge: (n) => {
          if (n === 1) writeFileSync(`${base(dir)}.pending.json.tmp-${process.pid}-${Date.now()}`, 'not ours');
        },
      });
      const query = runner.query;
      runner.query = (statement) => {
        const rows = query(statement);
        return statement.trimEnd().endsWith('commit;')
          ? rows.map((row) => (row[0] === 'PURGE_RESULT' ? ['PURGE_RESULT', JSON.stringify({ ...RESULT, runId: 'run-2', auditId: 'audit-2' })] : row))
          : rows;
      };
      expect(await run(commitArgv(dir), runner, (l) => lines.push(l))).toBe(1);
      // Never truncated: the read pass's report is complete and readable, owner-only, and never shows its
      // rolled-back ids as committed.
      const pending = JSON.parse(readFileSync(`${base(dir)}.pending.json`, 'utf8'));
      expect(pending).toMatchObject({ mode: 'commit', runId: null, auditId: null });
      expect(readFileSync(`${base(dir)}.pending.md`, 'utf8')).toContain('| Audit row (discovery.tenant_purged) | unavailable |');
      expect(readFileSync(`${base(dir)}.pending.md`, 'utf8')).not.toContain('audit-1');
      expect(statSync(`${base(dir)}.pending.json`).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).some((file) => /\.md\.tmp-/.test(file))).toBe(false);
      expect(lines.some((line) => line.includes('intact') && line.includes('audit-2'))).toBe(true);
    });

    it('keeps the pending report, with no ids, and exits non-zero when the committed output cannot be read', async () => {
      const unreadable: Array<(rows: string[][]) => string[][]> = [
        (rows) => rows.filter((row) => row[0] !== 'PURGE_RESULT'),
        (rows) => rows.map((row) => (row[0] === 'PURGE_RESULT' ? ['PURGE_RESULT', '{not json'] : row)),
      ];
      for (const corrupt of unreadable) {
        pin();
        const dir = outDir();
        const lines: string[] = [];
        const { runner } = fakeRunner();
        const query = runner.query;
        runner.query = (statement) => {
          const rows = query(statement);
          return statement.trimEnd().endsWith('commit;') ? corrupt(rows) : rows;
        };
        expect(await run(commitArgv(dir), runner, (l) => lines.push(l))).toBe(1);
        const name = base(dir).split('/').pop();
        // No final report: only the pending files, which hold the read pass's counts and no ids.
        expect(readdirSync(dir).sort()).toEqual([`${name}.pending.json`, `${name}.pending.md`]);
        const pending = JSON.parse(readFileSync(`${base(dir)}.pending.json`, 'utf8'));
        expect(pending).toMatchObject({ mode: 'commit', runId: null, auditId: null });
        expect(pending.mail.source_items).toEqual({ before: 5, after: 1, held: 1, kept: 0 });
        expect(readFileSync(`${base(dir)}.pending.md`, 'utf8')).not.toContain('audit-1');
        expect(lines.some((line) => line.startsWith('Committed, but its output could not be read'))).toBe(true);
        expect(lines.some((line) => line.startsWith('Committed. Audit row'))).toBe(false);
        vi.useRealTimers();
      }
    });

    describe('when the commit pass fails after COMMIT may have reached the server', () => {
      const LOST = 'psql failed against 127.0.0.1:54322 (exit 2): server closed the connection unexpectedly\nconnection to server was lost';

      /** A commit whose connection drops: leaves the `.pending` files of an unknown outcome in `dir`. */
      async function unknownCommit(dir: string, lines: string[] = []) {
        const { runner } = fakeRunner({
          onPurge: (n) => {
            if (n === 1) throw new Error(LOST);
          },
        });
        expect(await run(commitArgv(dir), runner, (l) => lines.push(l))).toBe(1);
        return `${base(dir)}.pending.json`;
      }

      /** A psql that answers the audit row lookup with `rows`, recording the statement. */
      function auditRunner(rows: string[][]) {
        const sql: string[] = [];
        const runner: PsqlRunner = {
          target: '127.0.0.1:54322/postgres',
          query: (statement) => {
            sql.push(statement);
            return rows;
          },
        };
        return { runner, sql };
      }
      const resolveArgv = (pending: string) => ['--tenant', TENANT, '--resolve', pending];

      it('tells a server ERROR (rolled back) from any other failure (unknown)', () => {
        expect(commitPassOutcome(new Error('psql failed against h (exit 1): ERROR:  fingerprint_mismatch: x'))).toBe('rolled_back');
        expect(commitPassOutcome(new Error(LOST))).toBe('unknown');
        expect(commitPassOutcome(new Error('spawnSync psql ENOBUFS'))).toBe('unknown');
        expect(commitPassOutcome(new Error('psql failed against h (exit 2): FATAL:  terminating connection'))).toBe('unknown');
      });

      it('keeps the pending report, says the outcome is unknown, and exits non-zero', async () => {
        pin();
        const dir = outDir();
        const lines: string[] = [];
        const pending = await unknownCommit(dir, lines);
        const name = base(dir).split('/').pop();
        expect(readdirSync(dir).sort()).toEqual([`${name}.pending.json`, `${name}.pending.md`]);
        expect(JSON.parse(readFileSync(pending, 'utf8'))).toMatchObject({ mode: 'commit', runId: null, auditId: null });
        expect(lines.some((line) => line.startsWith('OUTCOME UNKNOWN'))).toBe(true);
        expect(lines).toContain(`Do not purge this tenant again. Settle it: --tenant ${TENANT} --resolve ${pending}`);
        expect(lines).not.toContain('Nothing was committed.');
        // The transaction may have rolled back: the retained report never certifies a deletion.
        const md = readFileSync(`${base(dir)}.pending.md`, 'utf8');
        expect(md).toContain('Pending: not yet confirmed.');
        expect(md).not.toContain('Committed. The rows below were deleted.');
      });

      it('--resolve finalizes the report with the ids of exactly one matching audit row', async () => {
        pin();
        const dir = outDir();
        const pending = await unknownCommit(dir);
        const { runner, sql } = auditRunner([['AUDIT', 'audit-9', 'run-9']]);
        const lines: string[] = [];
        expect(await run(resolveArgv(pending), runner, (l) => lines.push(l))).toBe(0);
        expect(sql).toHaveLength(1);
        expect(sql[0]).toContain(`tenant_id = '${TENANT}'::uuid`);
        expect(sql[0]).toContain("action = 'discovery.tenant_purged'");
        expect(sql[0]).toContain("ts >= '2026-10-15T10:00:00.000Z'::timestamptz - interval '5 minutes'");
        expect(sql[0]).toContain(`(detail - 'runId') = '${JSON.stringify(RESULT.deleted)}'::jsonb`);
        const name = base(dir).split('/').pop();
        expect(readdirSync(dir).sort()).toEqual([`${name}.json`, `${name}.md`]);
        expect(JSON.parse(readFileSync(`${base(dir)}.json`, 'utf8'))).toMatchObject({ mode: 'commit', runId: 'run-9', auditId: 'audit-9' });
        expect(readFileSync(`${base(dir)}.md`, 'utf8')).toContain('audit-9');
        expect(readFileSync(`${base(dir)}.md`, 'utf8')).toContain('Committed. The rows below were deleted.');
        expect(readFileSync(`${base(dir)}.md`, 'utf8')).not.toContain('Pending: not yet confirmed.');
        expect(lines.at(-1)).toBe('Committed. Audit row audit-9 (discovery.tenant_purged).');
      });

      it('--resolve refuses on no matching audit row, or several, and leaves the pending report intact', async () => {
        for (const rows of [[], [['AUDIT', 'audit-8', 'run-8'], ['AUDIT', 'audit-9', 'run-9']]]) {
          pin();
          const dir = outDir();
          const pending = await unknownCommit(dir);
          const before = readFileSync(pending, 'utf8');
          const lines: string[] = [];
          expect(await run(resolveArgv(pending), auditRunner(rows).runner, (l) => lines.push(l))).toBe(1);
          expect(lines.some((line) => line.startsWith(`refused: ${rows.length} discovery.tenant_purged audit rows`))).toBe(true);
          expect(lines.some((line) => line.startsWith('The outcome stays unknown. Escalate'))).toBe(true);
          expect(readFileSync(pending, 'utf8')).toBe(before);
          expect(readdirSync(dir).every((file) => file.includes('.pending.'))).toBe(true);
          vi.useRealTimers();
        }
      });

      it('--resolve refuses a report of another tenant or target, or one already holding ids, before any lookup', async () => {
        pin();
        const dir = outDir();
        const pending = await unknownCommit(dir);
        const original = JSON.parse(readFileSync(pending, 'utf8'));
        for (const [override, why] of [
          [{ tenantId: OTHER }, `for tenant ${OTHER}`],
          [{ target: 'db.example:5432/postgres' }, 'ran against db.example:5432/postgres'],
          [{ auditId: 'audit-1' }, 'already holds the committed ids'],
          [{ mode: 'dry_run' }, 'not a commit report'],
        ] as const) {
          writeFileSync(pending, JSON.stringify({ ...original, ...override }));
          const { runner, sql } = auditRunner([['AUDIT', 'audit-9', 'run-9']]);
          const lines: string[] = [];
          expect(await run(resolveArgv(pending), runner, (l) => lines.push(l))).toBe(1);
          expect(sql).toEqual([]);
          expect(lines.some((line) => line.includes(why))).toBe(true);
        }
      });
    });

    it('on success writes pending files, then renames them to the final names, owner-only, with the committed ids', async () => {
      pin();
      const dir = outDir();
      let pendingDuringCommit: string[] = [];
      let pendingMarkdown = '';
      const { runner } = fakeRunner({
        onPurge: (n) => {
          if (n === 1) pendingDuringCommit = readdirSync(dir).sort();
          if (n === 1) pendingMarkdown = readFileSync(`${base(dir)}.pending.md`, 'utf8');
        },
        purge: undefined,
      });
      // The commit pass answers with its own run and audit ids.
      const query = runner.query;
      runner.query = (statement) => {
        const rows = query(statement);
        return statement.trimEnd().endsWith('commit;')
          ? rows.map((row) => (row[0] === 'PURGE_RESULT' ? ['PURGE_RESULT', JSON.stringify({ ...RESULT, runId: 'run-2', auditId: 'audit-2' })] : row))
          : rows;
      };
      expect(await run(commitArgv(dir), runner, () => {})).toBe(0);
      const name = base(dir).split('/').pop();
      // The report was on disk, durable, before the commit ran.
      expect(pendingDuringCommit).toEqual([`${name}.pending.json`, `${name}.pending.md`]);
      expect(readdirSync(dir).sort()).toEqual([`${name}.json`, `${name}.md`]);
      for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(`${base(dir)}.json`, 'utf8'))).toMatchObject({ mode: 'commit', runId: 'run-2', auditId: 'audit-2' });
      expect(readFileSync(`${base(dir)}.md`, 'utf8')).toContain('audit-2');
      // Written before COMMIT, the pending report never claims the deletion; the final one does.
      expect(pendingMarkdown).toContain('Pending: not yet confirmed.');
      expect(pendingMarkdown).not.toContain('Committed. The rows below were deleted.');
      expect(readFileSync(`${base(dir)}.md`, 'utf8')).toContain('Committed. The rows below were deleted.');
    });
  });

  it('counts and checks every TENANT_PURGE_TABLES table, before and after, with the tenant inlined', () => {
    const sql = purgeSql(TENANT, false);
    for (const [name, predicate] of Object.entries(TENANT_PURGE_TABLES)) {
      const line = `from ${name} t where ${predicate.replaceAll(":'tenant'", `'${TENANT}'`)}`;
      expect(sql.split(line).length - 1, name).toBe(2);
    }
    expect(sql).not.toContain(":'tenant'");
    // The check raises, so nothing after it (the commit included) runs when a mail row is left unexplained.
    expect(sql.indexOf('purge_incomplete')).toBeLessThan(sql.indexOf('rollback;'));
    expect(sql).toContain("heldResidueCounts'->>c.tbl");
    // Rows the retention policy keeps are explained apart from those legal hold keeps.
    expect(sql).toContain("policyKeptCounts'->>c.tbl");
    expect(sql).toContain('site_changed');
    expect(() => purgeSql("x'; drop table users; --", true, FP)).toThrow('uuid');
    // A commit needs the read pass's fingerprint, and only a bare md5 is inlined.
    expect(() => purgeSql(TENANT, true)).toThrow('fingerprint');
    expect(() => purgeSql(TENANT, true, "x'; drop table users; --")).toThrow('fingerprint');
    // Both passes print the same fingerprint, over counts and result without the volatile ids.
    expect(sql).toContain("r - 'runId' - 'auditId'");
    expect(purgeSql(TENANT, true, FP)).toContain(`is distinct from '${FP}'`);
    expect(sql).not.toContain('fingerprint_mismatch');
  });

  it('reports a failed transaction as refused, with nothing committed and no report', async () => {
    const { runner } = fakeRunner({ purge: new Error('psql failed against 127.0.0.1:54322 (exit 1): ERROR:  purge_incomplete: x') });
    const lines: string[] = [];
    const dir = outDir();
    expect(await run(commitArgv(dir), runner, (l) => lines.push(l))).toBe(1);
    expect(lines).toContain('Nothing was committed.');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses output without its marked rows (psql before 15 prints only the last result)', () => {
    expect(() => parsePurgeOutput([['ROLLBACK']])).toThrow('psql 15 or later');
    const rows = [['PURGE_FP', FP], ['PURGE_COUNTS', '{}'], ['PURGE_RESULT', JSON.stringify(RESULT)]];
    expect(parsePurgeOutput(rows)).toMatchObject({ fingerprint: FP, result: { runId: 'run-1' } });
  });

  it('writes a JSON and a Markdown report, owner-only, with the counts, the site rows and the held residue', async () => {
    const { runner } = fakeRunner();
    const dir = outDir();
    const lines: string[] = [];
    expect(await run(['--tenant', TENANT, '--out', dir], runner, (l) => lines.push(l))).toBe(0);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(new RegExp(`^tenant-purge-${TENANT}-\\d{8}T\\d{6}\\.\\d{3}Z-dry-run\\.json$`));
    expect(files[1]).toMatch(/-dry-run\.md$/);
    for (const file of files) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const report = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
    expect(report).toMatchObject({
      format: PURGE_REPORT_FORMAT,
      tenantId: TENANT,
      target: '127.0.0.1:54322/postgres',
      mode: 'dry_run',
      runId: 'run-1',
      auditId: 'audit-1',
      policy: RESULT.policy,
      fingerprint: FP,
      site: RESULT.site,
      deleted: RESULT.deleted,
      heldResidue: RESULT.heldResidue,
      messageIndex: RESULT.messageIndex,
    });
    expect(Object.keys(report.mail)).toEqual(Object.keys(TENANT_PURGE_TABLES));
    expect(report.mail.source_items).toEqual({ before: 5, after: 1, held: 1, kept: 0 });
    expect(report.mail.content_sources).toEqual({ before: 5, after: 0, held: 0, kept: 0 });
    expect(report.mail.discovery_message_index).toEqual({ before: 5, after: 1, held: 0, kept: 1 });

    const md = readFileSync(join(dir, files[1]), 'utf8');
    expect(md).toContain('Dry run.');
    expect(md).toContain('| `source_items` | 5 | 1 | 1 | 0 |');
    expect(md).toContain('| `discovery_message_index` | 5 | 1 | 0 | 1 |');
    expect(md).toContain('| cand-h | deal-h | 1 |');
    expect(md).toContain('| siteSources | 1 | 1 |');
    expect(md).toContain('| Lifecycle | decommissioning |');
    expect(md).toContain('| Message index at tenant end | exported and kept |');
    expect(md).toContain('The retention policy keeps the message index');
    expect(md).toContain('## Message index for the bank');
    expect(md).toContain('| 1604d28ce6c9c71520c827b85e9af7f6f7b93fb7dd7c6dc007f9569a857d86c0 | p-1 p-2 | src-1 | 2026-03-02T00:00:00+00:00 | deal-1 | mnpi promissory | rules-x |  |  |');
    expect(md).not.toMatch(/—/);
    // The console gets counts only.
    expect(lines).toContain('Held under legal hold: 1 candidate(s).');
    expect(lines).toContain('  discovery_message_index: 5 -> 1 (1 kept by policy)');
    expect(lines).toContain('Message index for the bank: 1 row(s).');
    expect(lines).toContain('Retention policy: decommissioning, message index at tenant end keep.');
    expect(lines.join('\n')).not.toContain('<m1@bank.example>');
  });

  it('never writes a report inside the repository', async () => {
    expect(() => prepareReportDir(join(REPO, 'evals', 'out', 'purge'), [REPO])).toThrow('outside the repository');
    expect(() => prepareReportDir(REPO, [REPO])).toThrow('outside the repository');
    const { runner } = fakeRunner();
    await expect(run(['--tenant', TENANT, '--out', join(REPO, 'purge-reports')], runner, () => {}, () => [REPO])).rejects.toThrow(
      'outside the repository',
    );
  });
});

// #529 review: a Message-ID is sender-written, so the bank's Markdown copy must show it as it is.
describe('the report escapes sender-written cell text', () => {
  it('turns line breaks into spaces and escapes what would end the cell or read as HTML, code spans kept', () => {
    expect(markdownCell('<id@host>')).toBe('\\<id@host\\>');
    expect(markdownCell('a|b\r\nc\nd')).toBe('a\\|b c d');
    expect(markdownCell('`table` x\\z&amp')).toBe('`table` x\\\\z&amp;amp');
    expect(markdownCell(null)).toBe('');
    expect(markdownCell(42)).toBe('42');
  });
});
