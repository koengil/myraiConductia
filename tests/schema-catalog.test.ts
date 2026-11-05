import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_PATH,
  formatSnapshot,
  hostOf,
  missingFrom,
  parseRows,
  parseSnapshot,
  readSchemaCatalog,
  readSnapshot,
  redact,
  runPsql,
  toCatalogLines,
} from '../scripts/lib/schemaCatalog';
import { TABLE } from '../src/lib/constants/tables';

const URL_WITH_SECRET = 'postgresql://u:SECRETPW@127.0.0.1:1/x';

/** Throws the way Node's execFileSync does: the full argv in the message. */
function failingPsql(stderr: string, status = 2) {
  return ((file: string, args: readonly string[]) => {
    const error = Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr}`), {
      status,
      stderr,
    });
    throw error;
  }) as unknown as Parameters<typeof runPsql>[2];
}

function fixedPsql(stdout: string) {
  return (() => stdout) as unknown as Parameters<typeof runPsql>[2];
}

describe('schema catalog parsing', () => {
  it('splits psql -At output into tab-separated rows and drops blank lines', () => {
    expect(parseRows('audit_log\tCHECK (a)\n\ndeals\tCHECK (b)\n')).toEqual([
      ['audit_log', 'CHECK (a)'],
      ['deals', 'CHECK (b)'],
    ]);
  });

  it('turns catalog rows into sorted, unique lines', () => {
    expect(
      toCatalogLines([
        ['table deal_steps'],
        ['function create_deal_gate0'],
        ['column deal_steps.bench_conversation_id'],
        ['function create_deal_gate0'],
        ['policy deals.deals_select_member'],
        [''],
      ]),
    ).toEqual([
      'column deal_steps.bench_conversation_id',
      'function create_deal_gate0',
      'policy deals.deals_select_member',
      'table deal_steps',
    ]);
  });

  it('reads the catalog through psql without a .psqlrc or a password prompt', () => {
    let seen: readonly string[] = [];
    const lines = readSchemaCatalog(URL_WITH_SECRET, ((_file: string, args: readonly string[]) => {
      seen = args;
      return 'table deals\ncolumn deals.status\n';
    }) as unknown as Parameters<typeof runPsql>[2]);
    expect(lines).toEqual(['column deals.status', 'table deals']);
    expect(seen).toEqual(expect.arrayContaining(['-X', '-w']));
  });

  it('leaves out objects an extension owns', () => {
    let sql = '';
    readSchemaCatalog(URL_WITH_SECRET, ((_file: string, args: readonly string[]) => {
      sql = args[args.indexOf('-c') + 1] ?? '';
      return '';
    }) as unknown as Parameters<typeof runPsql>[2]);
    expect(sql).toContain("d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'");
    expect(sql).toContain("d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'");
  });

  it('returns rows from a successful query', () => {
    expect(runPsql(URL_WITH_SECRET, 'select 1', fixedPsql('1\n'))).toEqual([['1']]);
  });
});

describe('psql failures never carry the credentials', () => {
  it('names the host and drops the password Node would print', () => {
    const run = () =>
      runPsql(
        URL_WITH_SECRET,
        'select 1',
        failingPsql(
          'psql: error: connection to server at "127.0.0.1", port 1 failed: Connection refused\n',
        ),
      );
    expect(run).toThrow(/^psql failed against 127\.0\.0\.1:1 \(exit 2\): psql: error: connection to server/);
    expect(run).not.toThrow(/SECRETPW/);
  });

  it('scrubs the URL and password if psql itself echoes them', () => {
    const run = () =>
      runPsql(
        URL_WITH_SECRET,
        'select 1',
        failingPsql(`psql: error: invalid URI "${URL_WITH_SECRET}" (SECRETPW)`, 1),
      );
    expect(run).toThrow(/psql failed against 127\.0\.0\.1:1/);
    expect(run).not.toThrow(/SECRETPW/);
  });

  it('redacts a percent-encoded password in both spellings', () => {
    const url = 'postgresql://u:p%40ss%23word@db.example.com:5432/postgres';
    expect(redact(`raw p%40ss%23word decoded p@ss#word`, url)).toBe('raw *** decoded ***');
  });

  it('says psql is missing rather than printing the argv', () => {
    const missing = (() => {
      throw Object.assign(new Error(`spawnSync psql ENOENT ${URL_WITH_SECRET}`), { code: 'ENOENT' });
    }) as unknown as Parameters<typeof runPsql>[2];
    const run = () => runPsql(URL_WITH_SECRET, 'select 1', missing);
    expect(run).toThrow('psql failed against 127.0.0.1:1: psql is not installed or not on PATH');
  });

  it('keeps the password out when the real psql binary fails or is absent', () => {
    let message = '';
    try {
      runPsql(URL_WITH_SECRET, 'select 1');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^psql failed against 127\.0\.0\.1:1/);
    expect(message).not.toContain('SECRETPW');
  });

  it('never echoes an unparseable URL as the host', () => {
    expect(hostOf('not a url SECRETPW')).not.toContain('SECRETPW');
  });
});

describe('views in the catalog', () => {
  it('round-trips a view line through the snapshot text and reports it when missing', () => {
    const lines = ['table deals', 'view allowed_mailboxes'];
    const text = formatSnapshot(lines);
    expect(text).toBe('table deals\nview allowed_mailboxes\n');
    expect(parseSnapshot(text)).toEqual(lines);
    expect(missingFrom(lines, ['table deals'])).toEqual(['view allowed_mailboxes']);
  });

  it('asks the catalog for relkind v views', () => {
    let sql = '';
    readSchemaCatalog(URL_WITH_SECRET, ((_file: string, args: readonly string[]) => {
      sql = args[args.indexOf('-c') + 1] ?? '';
      return 'view allowed_mailboxes\n';
    }) as unknown as Parameters<typeof runPsql>[2]);
    expect(sql).toContain("c.relkind = 'v'");
  });
});

describe('missingFrom', () => {
  const snapshot = [
    'column deal_steps.bench_conversation_id',
    'function create_deal_gate0',
    'policy deals.deals_select_member',
    'table deal_steps',
  ];

  it('is empty when the target holds every expected line', () => {
    expect(missingFrom(snapshot, snapshot)).toEqual([]);
  });

  it('ignores objects the target has beyond the snapshot', () => {
    expect(missingFrom(snapshot, [...snapshot, 'column deals.zz_probe', 'table extra'])).toEqual([]);
  });

  it('names each expected line the target lacks, in snapshot order', () => {
    expect(
      missingFrom(snapshot, ['function create_deal_gate0', 'table deal_steps']),
    ).toEqual(['column deal_steps.bench_conversation_id', 'policy deals.deals_select_member']);
  });

  it('reports everything against an empty target', () => {
    expect(missingFrom(snapshot, [])).toEqual(snapshot);
  });
});

describe('snapshot text', () => {
  it('formats sorted, unique, newline-terminated lines and parses them back', () => {
    const text = formatSnapshot(['table deals', 'column deals.status', 'table deals']);
    expect(text).toBe('column deals.status\ntable deals\n');
    expect(parseSnapshot(text)).toEqual(['column deals.status', 'table deals']);
  });

  it('parses blank lines and stray whitespace away', () => {
    expect(parseSnapshot('\n table deals \r\n\n')).toEqual(['table deals']);
  });
});

describe('supabase/schema-snapshot.txt', () => {
  const text = readFileSync(SNAPSHOT_PATH, 'utf8');
  const lines = readSnapshot();

  it('is exactly what the generator would write: sorted, no duplicates, one trailing newline', () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(text).toBe(formatSnapshot(lines));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('holds only table, view, column, function and policy lines', () => {
    const shape = /^(table [a-z0-9_]+|view [a-z0-9_]+|column [a-z0-9_]+\.[a-z0-9_]+|function [a-z0-9_]+|policy [a-z0-9_]+\.[a-z0-9_]+)$/;
    expect(lines.filter((line) => !shape.test(line))).toEqual([]);
  });

  it('lists every table the application names in src/lib/constants/tables', () => {
    // TABLE also names the views (allowed_mailboxes, mailbox_seated_invites).
    const tables = new Set(
      lines.filter((l) => l.startsWith('table ') || l.startsWith('view ')).map((l) => l.slice(l.indexOf(' ') + 1)),
    );
    expect(Object.values(TABLE).filter((t) => !tables.has(t))).toEqual([]);
  });

  it('carries the mailbox allowlist views', () => {
    expect(lines).toContain('view allowed_mailboxes');
    expect(lines).toContain('view mailbox_seated_invites');
  });

  it('carries the Sep 4 column', () => {
    expect(lines).toContain('column deal_steps.bench_conversation_id');
  });
});
