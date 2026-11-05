import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fetcher, PrFile } from '../scripts/check-migration-open-prs';
import {
  parseBigTables,
  checkHostedCounts,
  foldFunctions,
  definerAllowlist,
  functionKey,
  hasHostedCountsLine,
  lintAddedMigrations,
  lintMigration,
  loadContext,
  parseBrowserGrants,
  type LintContext,
} from '../scripts/check-migration-lint';

const ctx: LintContext = {
  browserGrants: new Set(['deals']),
  authenticatedDefiners: new Set(['accept_invite']),
  bigTables: parseBigTables(readFileSync('supabase/lint/big-tables.txt', 'utf8')),
  existingFunctions: new Map([
    ['old_definer()', true],
    ['old_invoker()', false],
  ]),
};
const lint = (sql: string, c: LintContext = ctx) => lintMigration('m.sql', sql, c);
const rules = (sql: string, c?: LintContext) => lint(sql, c).findings.map((f) => `${f.rule}:${f.line}`);

const GOOD_DEFINER = `create function public.f() returns int
  language sql security definer set search_path = public, pg_temp as $$ select 1 $$;
revoke all on function f from public, anon, authenticated;
grant execute on function f to service_role;
`;

describe('definer-search-path', () => {
  it('passes the repo form and its quoted and TO spellings', () => {
    expect(rules(GOOD_DEFINER)).toEqual([]);
    expect(rules(GOOD_DEFINER.replace('= public, pg_temp', "to 'public', 'pg_temp'"))).toEqual([]);
    expect(rules(GOOD_DEFINER.replace('= public, pg_temp', '= "public" ,pg_temp'))).toEqual([]);
  });

  it('fails the old `= public`, a reversed path, an extra entry and a missing path', () => {
    for (const path of ['set search_path = public', 'set search_path = pg_temp, public', 'set search_path = public, pg_temp, extensions', '']) {
      expect(rules(GOOD_DEFINER.replace('set search_path = public, pg_temp', path))).toEqual(['definer-search-path:1']);
    }
  });

  it('ignores invokers and other schemas', () => {
    expect(rules(GOOD_DEFINER.replace('security definer ', ''))).toEqual([]);
    expect(rules('create function pgboss.f() returns int language sql security definer set search_path = pgboss as $$ select 1 $$;')).toEqual([]);
  });

  it('reads the clause after the body too', () => {
    expect(rules(`create function f() returns int as $$ select 1 $$ language sql security definer set search_path = public, pg_temp;
revoke all on function f() from public, anon, authenticated;`)).toEqual([]);
  });
});

describe('definer-grants', () => {
  it('fails a new definer without the revoke and names the missing roles', () => {
    const { findings } = lint(GOOD_DEFINER.replace('revoke all on function f from public, anon, authenticated;', 'revoke all on function f() from public;'));
    expect(findings.map((f) => f.rule)).toEqual(['definer-grants']);
    expect(findings[0].problem).toContain('not revoked from anon, authenticated');
    expect(findings[0].fix).toContain('revoke all on function f from public, anon, authenticated;');
  });

  it('accepts revokes split over statements, signatures and lists', () => {
    expect(rules(`create function f(a uuid) returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;
revoke execute on function public.f(uuid), g(int) from public;
revoke all on function f(uuid) from anon,authenticated;`)).toEqual([]);
  });

  it('lets `create or replace` of an existing function keep its ACL', () => {
    expect(rules(`create or replace function old_definer() returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;`)).toEqual([]);
  });

  it('fails a new overload of an existing definer and an invoker turned definer', () => {
    expect(rules(`create or replace function old_definer(a int) returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;`)).toEqual(['definer-grants:1']);
    const { findings } = lint(`create or replace function old_invoker() returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;`);
    expect(findings.map((f) => `${f.rule}:${f.line}`)).toEqual(['definer-grants:1']);
    expect(findings[0].problem).toContain('replaces an invoker');
  });

  it('keys a function by its normalized argument types', () => {
    expect(functionKey('f', 'p_id uuid, in "Lim" int4 default 10, out total bigint')).toBe('f(uuid, integer)');
    expect(functionKey('f', 'at timestamptz, d double precision, v varchar(20)[], public.my_type')).toBe(
      'f(timestamp with time zone, double precision, character varying[], my_type)',
    );
    const ctx2 = { ...ctx, existingFunctions: new Map([['old_definer(uuid, integer)', true]]) };
    expect(rules(`create or replace function old_definer(p uuid, n int default 1) returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;`, ctx2)).toEqual([]);
  });

  it('matches a revoke to the created signature, and a bare revoke only when one overload exists', () => {
    const def = (args: string) => `create function f(${args}) returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;\n`;
    expect(rules(`${def('a int')}revoke all on function f(text) from public, anon, authenticated;`)).toEqual(['definer-grants:1']);
    expect(rules(`${def('a int')}revoke all on function f(integer) from public, anon, authenticated;`)).toEqual([]);
    expect(rules(`${def('a int')}revoke all on function f from public, anon, authenticated;`)).toEqual([]);
    // Two overloads: a bare revoke is ambiguous (Postgres refuses it), so it revokes nothing.
    expect(rules(`${def('a int')}${def('a text')}revoke all on function f from public, anon, authenticated;`)).toEqual(['definer-grants:1', 'definer-grants:2']);
    const withOld = { ...ctx, existingFunctions: new Map([['f(text)', false]]) };
    expect(rules(`${def('a int')}revoke all on function f from public, anon, authenticated;`, withOld)).toEqual(['definer-grants:1']);
    // Dropping the old overload first makes the bare revoke unambiguous again.
    expect(rules(`drop function if exists f(text);\n${def('a int')}revoke all on function f from public, anon, authenticated;`, withOld)).toEqual([]);
    expect(rules(`${def('a int')}revoke all on all functions in schema public from public, anon, authenticated;`)).toEqual([]);
  });

  it('treats a definer recreated after a drop as new: it gets a fresh default ACL', () => {
    const recreate = `drop function old_definer();
create function old_definer() returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;
`;
    expect(rules(recreate)).toEqual(['definer-grants:2']);
    expect(rules(`${recreate}revoke all on function old_definer from public, anon, authenticated;`)).toEqual([]);
  });

  it('counts only the revokes after the latest create of a signature', () => {
    const def = (n: string) => `create function ${n}() returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;`;
    const revoke = (n: string) => `revoke all on function ${n}() from public, anon, authenticated;`;
    // A revoke before a drop and recreate belongs to the dropped function.
    expect(rules(`${revoke('old_definer')}\ndrop function old_definer();\n${def('old_definer')}`)).toEqual(['definer-grants:3']);
    // A revoke before the create (the function did not exist yet) revokes nothing.
    expect(rules(`${revoke('f')}\n${def('f')}`)).toEqual(['definer-grants:2']);
    expect(rules(`${def('f')}\n${revoke('f')}`)).toEqual([]);
    // A schema-wide revoke covers the functions that exist at that point only.
    expect(rules(`revoke all on all functions in schema public from public, anon, authenticated;\n${def('f')}`)).toEqual(['definer-grants:2']);
    expect(rules(`${def('f')}\nrevoke all on all functions in schema public from public, anon, authenticated;`)).toEqual([]);
  });

  it('fails any execute grant to anon or public, and to authenticated off the allowlist, whoever created the function', () => {
    expect(rules('grant execute on function old_definer() to public;')).toEqual(['definer-grants:1']);
    expect(rules('grant execute on function old_invoker to anon;')).toEqual(['definer-grants:1']);
    expect(rules('grant execute on function some_rpc(uuid) to authenticated;')).toEqual(['definer-grants:1']);
    expect(rules('grant execute on function accept_invite(uuid) to authenticated, service_role;')).toEqual([]);
  });

  it('treats `alter function ... security definer` as making a definer', () => {
    const alter = 'alter function old_invoker() security definer;';
    expect(rules(alter)).toEqual(['definer-grants:1']);
    expect(rules(`${alter}\nrevoke all on function old_invoker() from public, anon, authenticated;`)).toEqual([]);
    // Already a definer: its ACL was already a definer's.
    expect(rules('alter function old_definer() security definer;')).toEqual([]);
  });

  it('fails a schema-wide function grant to a browser role or PUBLIC', () => {
    expect(rules('grant execute on all functions in schema public to anon;')).toEqual(['definer-grants:1']);
    expect(rules('grant all on all routines in schema public to public;')).toEqual(['definer-grants:1']);
    expect(rules('grant execute on all functions in schema public to service_role;')).toEqual([]);
  });

  it('fails a grant to anon or public', () => {
    expect(rules(`${GOOD_DEFINER}grant execute on function f to anon;`)).toEqual(['definer-grants:5']);
  });

  it('allows authenticated only for a name in definer_grants.sql, and then needs no revoke from it', () => {
    const accept = GOOD_DEFINER.replace(/\bf\b/g, 'accept_invite').replace('public, anon, authenticated', 'public, anon').replace('to service_role', 'to authenticated');
    expect(rules(accept)).toEqual([]);
    expect(rules(accept.replace(/accept_invite/g, 'other_rpc'))[0]).toBe('definer-grants:4');
  });

  it('reads the allowlist out of the DO block in definer_grants.sql', () => {
    const names = definerAllowlist(readFileSync(join(process.cwd(), 'supabase/tests/definer_grants.sql'), 'utf8'));
    expect(names.has('accept_invite')).toBe(true);
    expect(names.has('app_visible_candidate_ids')).toBe(true);
    expect(names.has('discovery_promote_candidate')).toBe(false);
  });
});

describe('table-grants', () => {
  it('passes a table on the allowlist, service_role grants and function grants', () => {
    expect(rules('grant select on deals to authenticated;\ngrant select on ai_usage to service_role;\ngrant execute on function x to authenticated;').filter((r) => r.startsWith('table-grants'))).toEqual([]);
  });

  it('fails an unlisted table, each one in a list, and column grants', () => {
    expect(rules('grant select, update on table public.deals, ai_usage to anon, authenticated;')).toEqual(['table-grants:1']);
    expect(rules('grant select (id, name) on ai_usage to authenticated;')).toEqual(['table-grants:1']);
  });

  it('treats PUBLIC as a browser grant', () => {
    expect(rules('grant select on ai_usage to public;')).toEqual(['table-grants:1']);
    expect(rules('grant select on deals to public;')).toEqual([]);
  });

  it('fails a grant on all tables in a schema', () => {
    expect(rules('grant select on all tables in schema public to authenticated;')).toEqual(['table-grants:1']);
  });

  it('parses the allowlist and refuses an entry without a reason', () => {
    expect(parseBrowserGrants('# c\ndeals: the deal page\n\nusers:\n').problems).toEqual([
      'supabase/lint/browser-grants.txt:4 needs `table: reason`, got "users:"',
    ]);
    const seeded = parseBrowserGrants(readFileSync(join(process.cwd(), 'supabase/lint/browser-grants.txt'), 'utf8'));
    expect(seeded.problems).toEqual([]);
    expect(seeded.tables.has('audit_log')).toBe(true);
    expect(seeded.tables.has('feature_flags')).toBe(false);
  });
});

describe('hosted-catalog', () => {
  it('fails a DO block that reads a catalog', () => {
    expect(rules("do $$ begin perform 1 from pg_class where relname = 'x'; end $$;")).toEqual(['hosted-catalog:1']);
  });

  it('fails a function loop over the catalog, not a function that merely mentions it in a string', () => {
    expect(rules(`create function g() returns void language plpgsql as $$
declare r record;
begin
  for r in select oid from pg_proc where prosecdef loop
    null;
  end loop;
end $$;`)).toEqual(['hosted-catalog:1']);
    expect(rules("create function g() returns text language sql as $$ select 'pg_proc' $$;")).toEqual([]);
  });

  it('ignores a top-level read and a catalog named in a comment', () => {
    expect(rules('select count(*) from pg_class;\n-- pg_proc\ndo $$ begin null; end $$;')).toEqual([]);
  });
});

describe('heavy-lock', () => {
  it('fails an index on a big table, not on a small one or a table this file creates', () => {
    expect(rules('create index if not exists a on public.audit_log (at);')).toEqual(['heavy-lock:1']);
    expect(rules('create index a on deals (at);')).toEqual([]);
    expect(rules('create table audit_log (id int);\ncreate index a on audit_log (id);')).toEqual([]);
  });

  it('recommends CONCURRENTLY in its own file for a big table', () => {
    expect(lint('create index a on audit_log (at);').findings[0].fix).toContain('`create index concurrently if not exists` alone in its own migration file');
  });

  it('passes CONCURRENTLY alone in its file, and fails it beside other statements', () => {
    expect(rules('-- the index\ncreate index concurrently if not exists a on audit_log (at);')).toEqual([]);
    const { findings } = lint('select 1;\ncreate unique index concurrently a on deals (id);');
    expect(findings.map((f) => `${f.rule}:${f.line}`)).toEqual(['heavy-lock:2']);
    expect(findings[0].fix).toContain('own migration file');
  });

  it('fails a validated CHECK or FK on a big table and passes NOT VALID', () => {
    expect(rules("alter table ai_usage add constraint c check (source in ('a'));")).toEqual(['heavy-lock:1']);
    expect(rules('alter table audit_log add constraint fk foreign key (deal_id) references deals (id);')).toEqual(['heavy-lock:1']);
    expect(rules("alter table ai_usage add constraint c check (source in ('a')) not valid;")).toEqual([]);
  });

  it('fails a VALIDATE in the same file as the NOT VALID add, and points at the validate', () => {
    const { findings } = lint("alter table ai_usage add constraint c check (x > 0) not valid;\n\nalter table ai_usage validate constraint c;");
    expect(findings.map((f) => `${f.rule}:${f.line}`)).toEqual(['heavy-lock:3']);
    expect(findings[0].fix).toContain('later migration file');
  });
});

describe('lint-allow', () => {
  it('allows with a reason above, on, or trailing the statement, and lists the marker', () => {
    for (const sql of [
      '-- lint-allow: heavy-lock 12k rows on prod, under a second\ncreate index a on audit_log (at);',
      'create index a on audit_log (at); -- lint-allow: heavy-lock 12k rows on prod, under a second',
      'create index a\n  -- lint-allow: heavy-lock 12k rows on prod, under a second\n  on audit_log (at);',
    ]) {
      // The marker counts on the file's last statement too.
      expect(lint(`select 1;\n${sql}`).findings).toEqual([]);
      const r = lint(`select 1;\n${sql}\nselect 2;`);
      expect(r.findings).toEqual([]);
      expect(r.allowed).toEqual([{ rule: 'heavy-lock', file: 'm.sql', line: expect.any(Number), reason: '12k rows on prod, under a second' }]);
    }
  });

  it('does not count a marker without a reason, and says so', () => {
    const { findings } = lint('-- lint-allow: heavy-lock\ncreate index a on audit_log (at);');
    expect(findings.map((f) => f.rule)).toEqual(['heavy-lock']);
    expect(findings[0].problem).toContain('has no reason');
  });

  it('allows only the rule it names, and only its own statement', () => {
    expect(rules('-- lint-allow: table-grants why\ncreate index a on audit_log (at);')).toEqual(['heavy-lock:2']);
    expect(rules('create index a on audit_log (at);\n-- lint-allow: heavy-lock for the next one\ncreate index b on deals (at);')).toEqual(['heavy-lock:1']);
  });

  it('reads a marker inside a DO body', () => {
    expect(rules("do $$\nbegin\n  -- lint-allow: hosted-catalog filtered to the two names this file creates\n  perform 1 from pg_proc where proname in ('a', 'b');\nend $$;")).toEqual([]);
  });

  it('fails a marker that names an unknown rule', () => {
    expect(rules('-- lint-allow: heavy-locks typo\nselect 1;')).toEqual(['heavy-locks:1']);
  });

  it('never reads DDL inside a string or a dollar body as a statement', () => {
    expect(rules("select 'create index a on audit_log (x);';\ncreate function h() returns void language sql as $$ create index a on audit_log (x) $$;")).toEqual([]);
  });

  it('gives each finding its rule, file:line, the fix and the lint-allow syntax', async () => {
    const logs: string[] = [];
    const out = await lintAddedMigrations({
      base: 'origin/develop',
      ci: false,
      readOwn: () => [{ name: '20261021000000_x.sql', prefix: '20261021000000', sha: 's' }],
      readFile: () => 'select 1;\ncreate index a on audit_log (at);',
      context: { ctx, problems: [] },
      log: (l) => logs.push(l),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\[heavy-lock\] supabase\/migrations\/20261021000000_x\.sql:2 creates an index on audit_log/);
    expect(out[0]).toContain('Fix: ');
    expect(out[0]).toContain('-- lint-allow: heavy-lock <reason>');
  });
});

// A fake GitHub API: the PR's files and its body.
function fakeApi(prFiles: PrFile[], body: string | null, failWith?: number) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (failWith) return { ok: false, status: failWith, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (url.includes('/files') ? prFiles : { body }) };
  };
  return { fetcher, calls };
}

describe('several added files', () => {
  const DEF = (n: string) => `create function ${n}() returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;`;
  const lintFiles = (sqls: string[]) =>
    lintAddedMigrations({
      base: 'origin/develop',
      ci: false,
      readOwn: () => sqls.map((_, i) => ({ name: `2026102100000${i}_x.sql`, prefix: `2026102100000${i}`, sha: 's' })),
      readFile: (name) => sqls[Number(name.slice(13, 14))],
      context: { ctx, problems: [] },
      log: () => {},
    });

  it('credits a later file\'s revoke to a function an earlier added file creates', async () => {
    expect(await lintFiles([DEF('f'), 'revoke all on function f() from public, anon, authenticated;'])).toEqual([]);
  });

  it('fails a later file\'s grant to anon on a definer an earlier file created and revoked', async () => {
    const out = await lintFiles([`${DEF('f')}\nrevoke all on function f() from public, anon, authenticated;`, 'grant execute on function f() to anon;']);
    expect(out).toEqual([expect.stringMatching(/^\[definer-grants\] supabase\/migrations\/20261021000001_x\.sql:1 /)]);
  });

  it('does not credit a revoke across a drop in another file', async () => {
    const out = await lintFiles([`${DEF('f')}\nrevoke all on function f() from public, anon, authenticated;`, 'drop function f();', DEF('f')]);
    expect(out).toEqual([expect.stringMatching(/^\[definer-grants\] supabase\/migrations\/20261021000002_x\.sql:1 /)]);
    const old = await lintFiles(['revoke all on function old_definer() from public, anon, authenticated;', `drop function old_definer();\n${DEF('old_definer')}`]);
    expect(old).toEqual([expect.stringMatching(/^\[definer-grants\] supabase\/migrations\/20261021000001_x\.sql:2 /)]);
  });

  it('folds each added file into the context before linting the next', async () => {
    const files: Record<string, string> = {
      '20261021000000_a.sql': GOOD_DEFINER,
      '20261021000001_b.sql': 'create or replace function f() returns int language sql security definer set search_path = public, pg_temp as $$ select 2 $$;',
    };
    const out = await lintAddedMigrations({
      base: 'origin/develop',
      ci: false,
      readOwn: () => Object.keys(files).reverse().map((name) => ({ name, prefix: name.slice(0, 14), sha: 's' })),
      readFile: (name) => files[name],
      context: { ctx, problems: [] },
      log: () => {},
    });
    expect(out).toEqual([]);
    expect(ctx.existingFunctions.has('f()')).toBe(false);
  });

  it('carries a drop in one added file into the next', async () => {
    const files: Record<string, string> = {
      '20261021000000_a.sql': 'drop function if exists old_definer();',
      '20261021000001_b.sql': 'create function old_definer() returns int language sql security definer set search_path = public, pg_temp as $$ select 1 $$;',
    };
    const out = await lintAddedMigrations({
      base: 'origin/develop',
      ci: false,
      readOwn: () => Object.keys(files).map((name) => ({ name, prefix: name.slice(0, 14), sha: 's' })),
      readFile: (name) => files[name],
      context: { ctx, problems: [] },
      log: () => {},
    });
    expect(out).toEqual([expect.stringMatching(/^\[definer-grants\] supabase\/migrations\/20261021000001_b\.sql:1 /)]);
  });
});

describe('hosted-counts', () => {
  const triggers = (sql: string) => lint(sql).counts.map((c) => c.what);

  it('names unique indexes, SET NOT NULL, validated CHECK/FK, VALIDATE and row changes', () => {
    expect(
      triggers(`create unique index a on deals (name);
alter table deals alter column name set not null;
alter table deals add constraint c check (x > 0);
alter table deals add constraint f foreign key (y) references users (id);
alter table deals validate constraint c2;
update deals set x = 1;
delete from deals where false;
with s as (select 1) update deals set x = 2;
do $$ begin update deals set x = 3; end $$;`),
    ).toEqual([
      'a unique index on deals',
      'SET NOT NULL on deals',
      'a validated CHECK on deals',
      'a validated FOREIGN KEY on deals',
      'a VALIDATE CONSTRAINT on deals',
      'UPDATE of existing rows',
      'DELETE of existing rows',
      'UPDATE of existing rows',
      'a DO block that updates or deletes rows',
    ]);
  });

  it('skips NOT VALID, new tables, new columns, row changes inside a function and a widened value list', () => {
    expect(
      triggers(`alter table deals add constraint c check (x > 0) not valid;
create table t (id int);
create unique index u on t (id);
alter table deals add column if not exists k text;
create unique index k on deals (k) where k is not null;
create function f() returns void language sql as $$ update deals set x = 1 $$;
alter table deals drop constraint if exists deals_status_check;
alter table deals add constraint deals_status_check check (status in ('a', 'b', 'c'));`),
    ).toEqual([]);
  });

  it('counts a value-list restatement that removes a value on purpose', () => {
    expect(
      triggers(`alter table deals drop constraint if exists deals_status_check;
-- check-removes: c no longer written
alter table deals add constraint deals_status_check check (status in ('a', 'b'));`),
    ).toEqual(['a validated CHECK on deals']);
  });

  it('a lint-allow removes the trigger', () => {
    expect(triggers('-- lint-allow: hosted-counts the table is empty on every hosted database (counted 2026-10-21)\nupdate deals set x = 1;')).toEqual([]);
  });

  it('recognises the PR body line', () => {
    expect(hasHostedCountsLine('Summary\n\nHosted counts: dev 0, staging 0, prod 0 rows')).toBe(true);
    expect(hasHostedCountsLine('- **Hosted counts:** prod 3')).toBe(true);
    expect(hasHostedCountsLine('Hosted counts:\nprod 0 duplicates (select ...)')).toBe(true);
    expect(hasHostedCountsLine('Hosted counts: none, the table is new')).toBe(true);
    expect(hasHostedCountsLine('We ran the hosted counts: none')).toBe(false);
    expect(hasHostedCountsLine('Hosted counts:')).toBe(false);
    expect(hasHostedCountsLine('**Hosted counts:**\n\nNext section 3')).toBe(false);
    expect(hasHostedCountsLine('Hosted counts: none')).toBe(false);
    expect(hasHostedCountsLine(null)).toBe(false);
  });

  const counts = [{ file: 'supabase/migrations/x.sql', line: 3, what: 'SET NOT NULL on deals' }];

  it('in CI fails without the line and passes with it', async () => {
    const without = fakeApi([], 'No counts here');
    const problems = await checkHostedCounts({ counts, ci: true, repo: 'o/r', token: 't', pr: 7, fetcher: without.fetcher, log: () => {} });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^\[hosted-counts\] supabase\/migrations\/x\.sql:3 SET NOT NULL on deals/);
    expect(problems[0]).toContain('-- lint-allow: hosted-counts <reason>');
    expect(without.calls).toEqual(['https://api.github.com/repos/o/r/pulls/7']);

    const withLine = fakeApi([], 'Hosted counts: prod 0 nulls');
    expect(await checkHostedCounts({ counts, ci: true, repo: 'o/r', token: 't', pr: 7, fetcher: withLine.fetcher, log: () => {} })).toEqual([]);
  });

  it('warns and passes when the API fails', async () => {
    const logs: string[] = [];
    const { fetcher } = fakeApi([], null, 502);
    expect(await checkHostedCounts({ counts, ci: true, repo: 'o/r', token: 't', pr: 7, fetcher, log: (l) => logs.push(l) })).toEqual([]);
    expect(logs.join('\n')).toContain('GitHub API failed');
  });

  it('locally prints a reminder and passes', async () => {
    const logs: string[] = [];
    expect(await checkHostedCounts({ counts, ci: false, log: (l) => logs.push(l) })).toEqual([]);
    expect(logs.join('\n')).toContain('Hosted counts:');
  });

  it('in CI lints the files the API lists and reads the body once', async () => {
    const files: PrFile[] = [
      { filename: 'supabase/migrations/20261021000000_a.sql', status: 'added', sha: 's' },
      { filename: 'supabase/migrations/20261001000000_old.sql', status: 'modified', sha: 's' },
    ];
    const api = fakeApi(files, 'body');
    const out = await lintAddedMigrations({
      base: 'origin/develop',
      ci: true,
      pr: 9,
      repo: 'o/r',
      token: 't',
      fetcher: api.fetcher,
      readOwn: () => {
        throw new Error('git must not be read when the API answers');
      },
      readFile: (name) => (name === '20261021000000_a.sql' ? 'update deals set x = 1;' : 'create index a on audit_log (x);'),
      context: { ctx, problems: [] },
      log: () => {},
    });
    expect(out).toEqual([expect.stringMatching(/^\[hosted-counts\] supabase\/migrations\/20261021000000_a\.sql:1 UPDATE/)]);
    expect(api.calls).toEqual(['https://api.github.com/repos/o/r/pulls/9/files?per_page=100&page=1', 'https://api.github.com/repos/o/r/pulls/9']);
  });
});

describe('calibration on the real migrations', () => {
  it('flags no definer search path since #312 and no table grant outside the seeded allowlist since it', () => {
    const dir = join(process.cwd(), 'supabase/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const base = loadContext(new Set(files)).ctx;
    const existing = new Map<string, boolean>();
    const flagged: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const r = lintMigration(file, sql, { ...base, existingFunctions: new Map(existing) });
      foldFunctions(sql, existing);
      if (file >= '20261016100000') flagged.push(...r.findings.filter((f) => f.rule !== 'heavy-lock' && f.rule !== 'hosted-catalog').map((f) => `${f.rule} ${file}:${f.line}`));
    }
    expect(flagged).toEqual([]);
  });
});
