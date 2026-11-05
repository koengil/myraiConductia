import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkHistory,
  definitionsIn,
  findDroppedValues,
  formatCheckListProblem,
  listValues,
} from '../scripts/check-migration-check-lists';

function migrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'check-lists-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

const restate = (values: string[], extra = '') =>
  `${extra}alter table ai_usage drop constraint if exists ai_usage_source_check;\n` +
  `alter table ai_usage add constraint ai_usage_source_check\n  check (source in (\n    ${values.map((v) => `'${v}'`).join(',\n    ')}\n  ))\n  not valid;\n`;

describe('restated CHECK lists keep every earlier value', () => {
  it('passes the real migrations', () => {
    const problems = findDroppedValues(checkHistory(join(process.cwd(), 'supabase/migrations')));
    expect(problems.map(formatCheckListProblem)).toEqual([]);
  });

  it('reports a stale restatement: constraint, file, dropped values and the file that last had them', () => {
    const dir = migrations({
      '20260101000000_create.sql': `create table ai_usage (\n  id uuid primary key,\n  source text not null check (source in ('screen','agent_run'))\n);\n`,
      '20260201000000_widen.sql': restate(['screen', 'agent_run', 'purge_a', 'purge_b']),
      '20260301000000_stale.sql': restate(['screen', 'agent_run', 'skill_run']),
    });
    expect(findDroppedValues(checkHistory(dir))).toEqual([
      {
        table: 'public.ai_usage',
        constraint: 'ai_usage_source_check',
        file: '20260301000000_stale.sql',
        dropped: ['purge_a', 'purge_b'],
        lastHadIn: '20260201000000_widen.sql',
      },
    ]);
  });

  it('passes a drop a later restatement repairs', () => {
    const dir = migrations({
      'a_1.sql': restate(['x', 'y']),
      'a_2.sql': restate(['x']),
      'a_3.sql': restate(['x', 'y', 'z']),
    });
    expect(findDroppedValues(checkHistory(dir))).toEqual([]);
  });

  it('accepts a removal marked on the statement or on the drop before it, and only with a reason', () => {
    const marked = (marker: string) =>
      migrations({ 'a_1.sql': restate(['x', 'y', 'z']), 'a_2.sql': restate(['x'], marker) });
    expect(findDroppedValues(checkHistory(marked("-- check-removes: y, 'z' retired with the old composer\n")))).toEqual([]);
    expect(findDroppedValues(checkHistory(marked('-- check-removes: y retired\n')))[0].dropped).toEqual(['z']);
    expect(findDroppedValues(checkHistory(marked('-- check-removes: y, z\n')))[0].dropped).toEqual(['y', 'z']);
    // The marker inside the add statement itself.
    const inside = migrations({
      'a_1.sql': restate(['x', 'y']),
      'a_2.sql': "alter table ai_usage add constraint ai_usage_source_check\n  -- check-removes: y no longer written\n  check (source in ('x'));\n",
    });
    expect(findDroppedValues(checkHistory(inside))).toEqual([]);
    // A removed value stays removed for later restatements.
    const later = migrations({
      'a_1.sql': restate(['x', 'y']),
      'a_2.sql': restate(['x'], '-- check-removes: y gone\n'),
      'a_3.sql': restate(['x', 'w']),
    });
    expect(findDroppedValues(checkHistory(later))).toEqual([]);
  });

  it('tracks each constraint by table and name, including = any (array[...]) and nullable forms', () => {
    const dir = migrations({
      'a_1.sql':
        "alter table audit_log add constraint audit_log_action_check check (action = any (array[\n  'view', 'purge.run'\n]));\n" +
        "alter table ops add constraint ops_code_check check (\n  code is null or code in ('a', 'b')\n);\n",
      'a_2.sql':
        "alter table audit_log add constraint audit_log_action_check check (action = any (array['view'::text]));\n" +
        "alter table ops add constraint ops_code_check check (code is null or code = any (array['a', 'b', 'c']));\n",
    });
    expect(findDroppedValues(checkHistory(dir)).map(formatCheckListProblem)).toEqual([
      "public.audit_log audit_log_action_check in a_2.sql drops 'purge.run' (last allowed by a_1.sql)",
    ]);
  });
});

describe('what counts as a value-list CHECK', () => {
  it('reads in-lists, arrays, casts and pg_dump spelling', () => {
    expect(listValues("source in ('a','b')")?.values).toEqual(['a', 'b']);
    expect(listValues("(source)::text = ANY ((ARRAY['a'::text, 'b'::text])::text[])")?.values).toEqual(['a', 'b']);
    expect(listValues("status_code is null or status_code = any (array['x'])")?.values).toEqual(['x']);
    expect(listValues("note in ('it''s')")?.values).toEqual(["it's"]);
  });

  it('ignores shape checks and comparisons', () => {
    expect(listValues("(decision = 'routed') = (method is not null)")).toBeUndefined();
    expect(listValues("kind <> 'sharepoint_site' or provider = 'microsoft'")).toBeUndefined();
    expect(listValues("a is null or b in ('x')")).toBeUndefined();
    expect(listValues('phase >= 0')).toBeUndefined();
  });

  it('names an unnamed column CHECK as Postgres does, and skips quoted text and function bodies', () => {
    const sql =
      "create table if not exists public.notifications (\n  id uuid,\n  event_type text not null check (event_type in ('a', 'b')),\n" +
      "  constraint notifications_pair_check check ((id is null) = (event_type is null))\n);\n" +
      "alter table notifications add column kind text check (kind in ('k'));\n" +
      "create function f() returns void language plpgsql as $$ begin\n  execute 'alter table t add constraint t_x_check check (x in (''q''))';\nend $$;\n" +
      "-- alter table t add constraint t_y_check check (y in ('commented'));\n";
    expect(definitionsIn('f.sql', sql).map((d) => [d.constraint, d.values])).toEqual([
      ['notifications_event_type_check', ['a', 'b']],
      ['notifications_kind_check', ['k']],
    ]);
  });

  it('reads -- and /* inside a quoted value as text, not as a comment', () => {
    const sql =
      "alter table t add constraint t_s_check check (s in ('a--b', 'c/*d', 'e'));\n" +
      'alter table "we--ird" add constraint w_check check (k in (\'x\'));\n';
    expect(definitionsIn('f.sql', sql).map((d) => [d.table, d.constraint, d.values])).toEqual([
      ['public.t', 't_s_check', ['a--b', 'c/*d', 'e']],
      ['public.we--ird', 'w_check', ['x']],
    ]);
    const dir = migrations({
      'a_1.sql': "alter table t add constraint t_s_check check (s in ('a--b', 'c'));\n",
      'a_2.sql': "alter table t drop constraint t_s_check;\nalter table t add constraint t_s_check check (s in ('c'));\n",
    });
    expect(findDroppedValues(checkHistory(dir)).map(formatCheckListProblem)).toEqual([
      "public.t t_s_check in a_2.sql drops 'a--b' (last allowed by a_1.sql)",
    ]);
  });

  it('ignores every CHECK inside a dollar-quoted body, and skips nested block comments', () => {
    const sql =
      "create function f() returns void language plpgsql as $$ begin\n  alter table t add constraint t_x_check check (x in ('q'));\nend $$;\n" +
      "do $body1$ begin alter table t add constraint t_y_check check (y in ('r')); end $body1$;\n" +
      "/* outer /* inner */ alter table t add constraint t_z_check check (z in ('s')); */\n" +
      "alter table t add constraint t_w_check check (w in ('$$', 'v'));\n";
    expect(definitionsIn('f.sql', sql).map((d) => [d.constraint, d.values])).toEqual([['t_w_check', ['$$', 'v']]]);
  });

  it('names an unnamed table CHECK and an unnamed add check after the first column, as Postgres does', () => {
    const sql =
      "create table app.t (\n  s text,\n  check (s in ('a', 'b'))\n);\n" +
      "alter table only app.t add check (k is null or k in ('x'));\n" +
      "alter table app.t add constraint t_named_check check (n in ('y')), add check (m in ('z'));\n";
    expect(definitionsIn('f.sql', sql).map((d) => [d.table, d.constraint, d.values])).toEqual([
      ['app.t', 't_s_check', ['a', 'b']],
      ['app.t', 't_k_check', ['x']],
      ['app.t', 't_named_check', ['y']],
      ['app.t', 't_m_check', ['z']],
    ]);
    const dir = migrations({
      'a_1.sql': "create table t (\n  s text,\n  check (s in ('a', 'b'))\n);\n",
      'a_2.sql': "alter table t drop constraint t_s_check;\nalter table t add constraint t_s_check check (s in ('a'));\n",
    });
    expect(findDroppedValues(checkHistory(dir)).map(formatCheckListProblem)).toEqual([
      "public.t t_s_check in a_2.sql drops 'b' (last allowed by a_1.sql)",
    ]);
  });

  it('tracks a constraint name per table: the same name on two tables is two constraints', () => {
    const dir = migrations({
      'a_1.sql':
        "alter table a add constraint kind_check check (kind in ('x', 'y'));\n" +
        "alter table public.b add constraint kind_check check (kind in ('x'));\n",
      'a_2.sql': "alter table if exists only public.a add constraint kind_check check (kind in ('x'));\n",
      'a_3.sql': "alter table \"b\" add constraint kind_check check (kind in ('x', 'y'));\n",
    });
    expect(findDroppedValues(checkHistory(dir)).map(formatCheckListProblem)).toEqual([
      "public.a kind_check in a_2.sql drops 'y' (last allowed by a_1.sql)",
    ]);
  });
});
