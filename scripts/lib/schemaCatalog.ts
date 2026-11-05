import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The one catalog query both the schema snapshot (scripts/schema-snapshot.ts)
 * and the database preflight read, so the two sides cannot disagree on shape.
 * It reads pg_class, pg_attribute, pg_namespace, pg_proc, pg_policy and
 * pg_depend only. Those are readable by PUBLIC, so the production gate can run
 * as a role with no grants at all; information_schema would hide every table
 * the role holds no privilege on.
 *
 * Each object is one line: "table deal_steps", "view allowed_mailboxes", "column deal_steps.work",
 * "function create_deal_gate0", "policy deals.deals_select_member".
 * Objects an extension owns (pg_depend deptype 'e') are left out: they belong
 * to however the platform installed the extension, not to a migration.
 */

const NOT_EXTENSION_TABLE = `not exists (
     select 1 from pg_depend d
      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`;

const CATALOG_SQL = `
select 'table ' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
   and ${NOT_EXTENSION_TABLE}
union all
select 'view ' || c.relname
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
   and ${NOT_EXTENSION_TABLE}
union all
select 'column ' || c.relname || '.' || a.attname
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
   and a.attnum > 0 and not a.attisdropped
   and ${NOT_EXTENSION_TABLE}
union all
select 'function ' || p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and not exists (
     select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
union all
select 'policy ' || c.relname || '.' || pol.polname
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and ${NOT_EXTENSION_TABLE}
`;

type RunFile = typeof execFileSync;

/** The committed snapshot: what every database built from this commit contains. */
export const SNAPSHOT_PATH = join(process.cwd(), 'supabase/schema-snapshot.txt');

/**
 * DATABASE_URL from a named env file, through a `node --env-file` child so the
 * file is never sourced and nothing else in it is read.
 */
export function resolveDatabaseUrl(envFile: string, runFile: RunFile = execFileSync): string {
  const url = (
    runFile(
      'node',
      [`--env-file=${envFile}`, '-e', "process.stdout.write(process.env.DATABASE_URL ?? '')"],
      { encoding: 'utf8' },
    ) as string
  ).trim();
  if (!url) {
    throw new Error(
      `DATABASE_URL is not set in ${envFile}. Copy it from Supabase: ` +
        'Settings -> Database -> Connection string -> Session pooler (IPv4).',
    );
  }
  if (!URL.canParse(url)) {
    // Say so here: an uncaught `new URL` error would print the whole value.
    throw new Error(`DATABASE_URL in ${envFile} is not a postgresql:// URL.`);
  }
  return url;
}

/** host[:port] of a connection URL, for messages. Never the credentials. */
export function hostOf(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).host || 'an unnamed host';
  } catch {
    // `new URL` puts the whole input on the error it throws. Do not rethrow it.
    return 'an unparseable DATABASE_URL';
  }
}

/** Remove the URL, and its password in both raw and decoded form, from text. */
export function redact(text: string, databaseUrl: string): string {
  const secrets = [databaseUrl];
  try {
    const { password } = new URL(databaseUrl);
    if (password) {
      secrets.push(password);
      secrets.push(decodeURIComponent(password));
    }
  } catch {
    // Not a URL, or a malformed percent escape: what could be listed already is.
  }
  let out = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('***');
  }
  return out;
}

/** psql -At -F '\t' output into rows of fields. */
export function parseRows(stdout: string): string[][] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t'));
}

/**
 * Run one statement and return its rows. On failure the thrown message names
 * the host and carries psql's own diagnostic with the credentials removed.
 * Node's execFileSync error would print the full argv, password included.
 * -X skips any local .psqlrc; -w never waits on a password prompt.
 */
export function runPsql(databaseUrl: string, sql: string, runFile: RunFile = execFileSync): string[][] {
  let stdout: string;
  try {
    stdout = runFile('psql', ['-X', '-w', '-A', '-t', '-F', '\t', '-d', databaseUrl, '-c', sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // The tenant purge (#461) returns its whole result as one JSON line, which grows with the tenant's
      // rows; the 1 MiB default is too small for a large one.
      maxBuffer: 256 * 1024 * 1024,
    }) as string;
  } catch (error) {
    const { status, stderr, code } = (error ?? {}) as {
      status?: number | null;
      stderr?: string | Buffer;
      code?: string;
    };
    const detail =
      code === 'ENOENT'
        ? 'psql is not installed or not on PATH'
        : redact(String(stderr ?? '').trim(), databaseUrl);
    const exit = typeof status === 'number' ? ` (exit ${status})` : '';
    throw new Error(`psql failed against ${hostOf(databaseUrl)}${exit}${detail ? `: ${detail}` : ''}`);
  }
  return parseRows(stdout);
}

/** Catalog rows into sorted, unique lines. Overloaded functions collapse to one. */
export function toCatalogLines(rows: readonly (readonly string[])[]): string[] {
  const lines = new Set<string>();
  for (const [line] of rows) {
    const trimmed = line?.trim();
    if (trimmed) lines.add(trimmed);
  }
  return [...lines].sort();
}

/** Every table, view, column, function and policy in the public schema, one per line. */
export function readSchemaCatalog(databaseUrl: string, runFile: RunFile = execFileSync): string[] {
  return toCatalogLines(runPsql(databaseUrl, CATALOG_SQL, runFile));
}

/** Snapshot text into its lines. */
export function parseSnapshot(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Catalog lines into the snapshot file's text: sorted, unique, newline-terminated. */
export function formatSnapshot(lines: readonly string[]): string {
  return `${toCatalogLines(lines.map((line) => [line])).join('\n')}\n`;
}

/** The committed snapshot's lines. Throws when it is missing, so the gate fails closed. */
export function readSnapshot(path: string = SNAPSHOT_PATH): string[] {
  return parseSnapshot(readFileSync(path, 'utf8'));
}

/**
 * Expected lines the target lacks, in expected order. A subset check: extra
 * objects in the target are ignored (the expand phase, or platform-managed ones).
 */
export function missingFrom(expected: readonly string[], actual: readonly string[]): string[] {
  const present = new Set(actual);
  return expected.filter((line) => !present.has(line));
}
