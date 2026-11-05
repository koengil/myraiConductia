/**
 * pg_stat_statements on the #162 throwaway database. Run under
 * scripts/perf/with-local-stack.sh, whose preload has already refused any
 * non-local DATABASE_URL before this module loads; psql() checks the stack
 * again before every call, so an import from another entry point is refused too.
 * enable and reset write, so they also need `with-local-stack.sh --write`
 * (assertWriteChecked: the running containers were confirmed as this stack's).
 *
 *   with-local-stack.sh --write node --import tsx scripts/perf/pg-stat.ts enable   # create extension (throwaway DB only)
 *   with-local-stack.sh --write node --import tsx scripts/perf/pg-stat.ts reset
 *   with-local-stack.sh node --import tsx scripts/perf/pg-stat.ts top [n]
 */
import { execFileSync } from 'node:child_process';

import { assertLocalStack, assertWriteChecked } from './localStack.mjs';

export type StatementRow = {
  queryid: string;
  calls: number;
  total_ms: number;
  mean_ms: number;
  max_ms: number;
  rows: number;
  query: string;
};

/**
 * psql's environment: no inherited PG* variable, no service or password file
 * (a ~/.pg_service.conf or ~/.pgpass can never redirect or authenticate it),
 * and the password through the environment, never argv (ps would show it).
 */
export function psqlEnv(base: NodeJS.ProcessEnv, url: URL): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of Object.keys(env)) if (name.startsWith('PG')) delete env[name];
  env.PGSERVICEFILE = '/dev/null';
  env.PGPASSFILE = '/dev/null';
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  return env;
}

function psql(sql: string): string {
  assertLocalStack(process.env);
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('pg-stat: DATABASE_URL is required');
  const url = new URL(raw);
  const env = psqlEnv(process.env, url);
  const args = ['-X', '-h', url.hostname.replace(/^\[|\]$/g, ''), '-p', url.port, '-d', url.pathname.slice(1)];
  if (url.username) args.push('-U', decodeURIComponent(url.username));
  try {
    return execFileSync('psql', [...args, '-v', 'ON_ERROR_STOP=1', '-At', '-q', '-c', sql], {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
    });
  } catch (error) {
    const stderr = error !== null && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
    const detail = url.password ? stderr.split(decodeURIComponent(url.password)).join('[redacted]') : stderr;
    throw new Error(`pg-stat: psql failed against ${url.hostname}:${url.port}${url.pathname}: ${detail.trim()}`);
  }
}

export function enablePgStatStatements(): string {
  assertWriteChecked(process.env);
  psql('create extension if not exists pg_stat_statements with schema extensions;');
  return psql(
    "select extversion || ' preload=' || current_setting('shared_preload_libraries') from pg_extension where extname = 'pg_stat_statements';",
  ).trim();
}

export function resetPgStatStatements(): void {
  assertWriteChecked(process.env);
  psql('select extensions.pg_stat_statements_reset();');
}

/** Top statements on the app database, by total execution time and by calls. */
export function topStatements(limit = 15): { byTotal: StatementRow[]; byCalls: StatementRow[] } {
  const select = (order: string) => `
    select coalesce(json_agg(t), '[]'::json) from (
      select queryid::text as queryid, calls, round(total_exec_time::numeric, 3)::float8 as total_ms,
             round(mean_exec_time::numeric, 3)::float8 as mean_ms, round(max_exec_time::numeric, 3)::float8 as max_ms,
             rows, left(regexp_replace(query, '\\s+', ' ', 'g'), 400) as query
      from extensions.pg_stat_statements s
      join pg_database d on d.oid = s.dbid
      where d.datname = current_database()
        and query not ilike '%pg_stat_statements%'
      order by ${order} desc
      limit ${Math.max(1, Math.floor(limit))}
    ) t;`;
  return {
    byTotal: JSON.parse(psql(select('total_exec_time')).trim()) as StatementRow[],
    byCalls: JSON.parse(psql(select('calls')).trim()) as StatementRow[],
  };
}

if (process.argv[1]?.endsWith('pg-stat.ts')) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'enable') {
    console.log(`pg_stat_statements ${enablePgStatStatements()}`);
  } else if (command === 'reset') {
    resetPgStatStatements();
    console.log('pg_stat_statements reset');
  } else if (command === 'top') {
    console.log(JSON.stringify(topStatements(arg ? Number(arg) : 15), null, 2));
  } else {
    console.error('usage: pg-stat.ts enable | reset | top [n]');
    process.exit(2);
  }
}
