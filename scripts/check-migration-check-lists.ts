import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A migration that widens a `CHECK (col in (...))` drops the constraint and
// re-adds it with the full list. One copied from a stale branch silently
// drops every value added in between, and each write of a dropped value then
// fails on the hosted database (#594 would have dropped six purge audit
// actions). This walks every migration in filename order, tracks each value
// list CHECK by table and constraint name, and reports a value that a restatement drops
// and no later one restores. A removal is deliberate only with a marker
// comment on the statement (or on the drop just before it):
//
//   -- check-removes: old_value, other_value why they go
//
// Only value-list CHECKs are tracked: `col in ('a', ...)`, `col = any
// (array['a', ...])`, optionally `col is null or ...` and `::text` casts.
// Anything else (shape checks, comparisons) is not a list and is ignored.

export type CheckDefinition = {
  // Schema-qualified table, `public` when the migration leaves it out.
  table: string;
  constraint: string;
  file: string;
  values: string[];
  // Values a `-- check-removes:` marker on this statement removes on purpose.
  removes: string[];
};

export type CheckListProblem = {
  table: string;
  constraint: string;
  file: string;
  dropped: string[];
  lastHadIn: string;
};

// `start` is the offset in the source of the segment's first character (an
// E'string' is rewritten, so its text may be shorter than the source).
export type Segment = { kind: 'code' | 'string' | 'ident' | 'comment' | 'dollar'; text: string; start: number };

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

// One pass over SQL as Postgres reads it: 'strings' with '' escapes,
// E'strings' with backslash escapes, "identifiers", $tag$ bodies, -- line
// comments and nested /* */ block comments. Everything else is code.
export function lex(sql: string): Segment[] {
  const out: Segment[] = [];
  let code = '';
  let codeStart = 0;
  let i = 0;
  const push = (kind: Segment['kind'], text: string) => {
    if (code) out.push({ kind: 'code', text: code, start: codeStart });
    code = '';
    out.push({ kind, text, start: i });
  };
  const addCode = (c: string) => {
    if (!code) codeStart = i;
    code += c;
  };
  while (i < sql.length) {
    const c = sql[i];
    const prev = i > 0 ? sql[i - 1] : '';
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      push('comment', sql.slice(i, stop));
      i = stop;
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          j += 2;
          if (--depth === 0) break;
        } else j++;
      }
      push('comment', sql.slice(i, j));
      i = j;
    } else if ((c === 'E' || c === 'e') && sql[i + 1] === "'" && !IDENT_CHAR.test(prev)) {
      let j = i + 2;
      while (j < sql.length) {
        if (sql[j] === '\\') j += 2;
        else if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      // Rewritten as a standard literal so later steps see one spelling.
      const value = sql
        .slice(i + 2, j)
        .replace(/''/g, "'")
        .replace(/\\(.)/g, '$1');
      push('string', `'${value.replace(/'/g, "''")}'`);
      i = j + 1;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      push(c === "'" ? 'string' : 'ident', sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === '$' && !IDENT_CHAR.test(prev)) {
      const tag = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end < 0 ? sql.length : end + tag.length;
        push('dollar', sql.slice(i, stop));
        i = stop;
      } else {
        addCode(c);
        i++;
      }
    } else {
      addCode(c);
      i++;
    }
  }
  if (code) out.push({ kind: 'code', text: code, start: codeStart });
  return out;
}

// Splits SQL into statements on top-level semicolons. Each statement keeps
// its leading comments, which is where a marker goes.
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const seg of lex(sql)) {
    if (seg.kind !== 'code') {
      current += seg.text;
      continue;
    }
    const parts = seg.text.split(';');
    parts.forEach((part, k) => {
      current += part;
      if (k < parts.length - 1) {
        out.push(`${current};`);
        current = '';
      }
    });
  }
  if (current.trim()) out.push(current);
  return out;
}

// The executed text of a statement: comments become a space and a
// dollar-quoted body (a function or DO block, not DDL this file runs)
// becomes an empty literal.
function codeOf(sql: string): string {
  return lex(sql)
    .map((seg) => (seg.kind === 'comment' ? ' ' : seg.kind === 'dollar' ? "''" : seg.text))
    .join('');
}

// `-- check-removes: a, 'b' reason`: the values before the reason. A marker
// without a reason does not count: a removal has to say why. Only real
// comments count, never text inside a string or a function body.
export function markerValues(statement: string): string[] {
  const values: string[] = [];
  for (const seg of lex(statement)) {
    if (seg.kind !== 'comment') continue;
    for (const m of seg.text.matchAll(/--\s*check-removes:\s*([^\s,]+(?:\s*,\s*[^\s,]+)*)[ \t]+\S[^\n]*/gi)) {
      for (const v of m[1].split(',')) values.push(v.trim().replace(/^'(.*)'$/, '$1'));
    }
  }
  return values;
}

// Skips the quoted string or identifier that opens at `i`; returns the index
// of its closing quote. Code from codeOf has only standard '' escapes.
function skipQuoted(sql: string, i: number): number {
  const q = sql[i];
  let j = i + 1;
  while (j < sql.length) {
    if (sql[j] === q && sql[j + 1] === q) j += 2;
    else if (sql[j] === q) return j;
    else j++;
  }
  return j;
}

// The text inside the parentheses that open at `open` (sql[open] === '(').
function balanced(sql: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') i = skipQuoted(sql, i);
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return sql.slice(open + 1, i);
  }
  return undefined;
}

const LITERAL = String.raw`'(?:[^']|'')*'(?:\s*::\s*(?:text|character varying|varchar))?`;
const LIST = String.raw`${LITERAL}(?:\s*,\s*${LITERAL})*`;
const COL = String.raw`\(?\s*"?([a-z_][a-z0-9_]*)"?\s*(?:::\s*text\s*)?\)?\s*(?:::\s*text\b)?`;
const VALUE_LIST = new RegExp(
  String.raw`^\s*\(?\s*(?:${COL}\s+is\s+null\s+or\s+)?${COL}\s*` +
    String.raw`(?:in\s*\(\s*(${LIST})\s*\)|=\s*any\s*\(\s*\(?\s*array\s*\[\s*(${LIST})\s*\]\s*\)?\s*(?:::\s*text\s*\[\s*\]\s*)?\))\s*\)?\s*$`,
  'i',
);

// The values of a value-list CHECK body, or undefined for any other CHECK.
export function listValues(body: string): { column: string; values: string[] } | undefined {
  const m = VALUE_LIST.exec(body);
  if (!m) return undefined;
  if (m[1] && m[1].toLowerCase() !== m[2].toLowerCase()) return undefined;
  const list = m[3] ?? m[4];
  return {
    column: m[2].toLowerCase(),
    values: [...list.matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1].replace(/''/g, "'")),
  };
}

// Splits a create-table body or an alter-table action list on top-level commas.
function topLevelItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"') i = skipQuoted(body, i);
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      items.push(body.slice(start, i));
      start = i + 1;
    }
  }
  items.push(body.slice(start));
  return items;
}

const NAMEDATALEN = 63;
const IDENT = String.raw`(?:"(?:[^"]|"")*"|[a-z_\u0080-￿][a-z0-9_$\u0080-￿]*)`;
const QNAME = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;

// An identifier as Postgres stores it: unquoted folds to lower case, quoted
// keeps its spelling, both cut to 63 characters.
function ident(raw: string): string {
  const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
  return name.slice(0, NAMEDATALEN);
}

function qualified(first: string, second: string | undefined): { schema: string; table: string } {
  return second ? { schema: ident(first), table: ident(second) } : { schema: 'public', table: ident(first) };
}

// Postgres's makeObjectName: `<table>_<column>_check`, shortening the longer
// of table and column until the name fits in 63 characters.
export function defaultCheckName(table: string, column: string): string {
  let a = table.length;
  let b = column.length;
  const avail = NAMEDATALEN - '_check'.length - 1;
  while (a + b > avail) {
    if (a > b) a--;
    else b--;
  }
  return `${table.slice(0, a)}_${column.slice(0, b)}_check`;
}

type Found = { name?: string; body: string };

// The CHECKs in one create-table item or alter-table action: named ones,
// and unnamed ones that Postgres names after the table and first column.
function checksIn(item: string): Found[] {
  const out: Found[] = [];
  for (const m of item.matchAll(/\bcheck\s*\(/gi)) {
    const body = balanced(item, (m.index ?? 0) + m[0].length - 1);
    if (body === undefined) continue;
    const named = new RegExp(String.raw`\bconstraint\s+(${IDENT})\s+$`, 'i').exec(item.slice(0, m.index));
    out.push({ name: named ? ident(named[1]) : undefined, body });
  }
  return out;
}

// The constraint names an `alter table` statement drops, keyed by table.
function droppedIn(code: string): { table: string; names: string[] } | undefined {
  const alter = new RegExp(String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QNAME}`, 'i').exec(code);
  if (!alter) return undefined;
  const { schema, table } = qualified(alter[1], alter[2]);
  const names = [...code.matchAll(new RegExp(String.raw`\bdrop\s+constraint\s+(?:if\s+exists\s+)?(${IDENT})`, 'gi'))].map(
    (m) => ident(m[1]),
  );
  return { table: `${schema}.${table}`, names };
}

// Every value-list CHECK one migration defines on a table, keyed by the
// schema-qualified table and the constraint name as Postgres names it: an
// explicit `constraint <name> check (...)`, or `<table>_<column>_check` for
// an unnamed CHECK (column or table level, `add column` or `add check`).
// Text in strings, comments and dollar-quoted bodies is never read as DDL.
export function definitionsIn(file: string, sql: string): CheckDefinition[] {
  const defs: CheckDefinition[] = [];
  const statements = splitStatements(sql);
  statements.forEach((raw, s) => {
    const code = codeOf(raw);
    let target: { schema: string; table: string } | undefined;
    let items: string[] = [];

    const create = new RegExp(
      String.raw`^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${QNAME}\s*\(`,
      'i',
    ).exec(code);
    const alter = new RegExp(String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${QNAME}`, 'i').exec(code);
    if (create) {
      target = qualified(create[1], create[2]);
      items = topLevelItems(balanced(code, create[0].length - 1) ?? '');
    } else if (alter) {
      target = qualified(alter[1], alter[2]);
      items = topLevelItems(code.slice(alter[0].length).replace(/;\s*$/, ''));
    }
    if (!target) return;
    const table = `${target.schema}.${target.table}`;

    for (const item of items) {
      for (const { name, body } of checksIn(item)) {
        const list = listValues(body);
        if (!list) continue;
        const constraint = name ?? defaultCheckName(target.table, list.column);
        // A marker may sit on the drop statement right before the re-add.
        const previous = s > 0 ? statements[s - 1] : '';
        const drop = previous ? droppedIn(codeOf(previous)) : undefined;
        const dropsSame = drop?.table === table && drop.names.includes(constraint);
        const removes = [...markerValues(raw), ...(dropsSame ? markerValues(previous) : [])];
        defs.push({ table, constraint, file, values: list.values, removes });
      }
    }
  });
  return defs;
}

// Deliberate removals in files released before the marker existed. A file on
// main cannot be edited, so its marker lives here. Add nothing new: a new
// migration carries its own `-- check-removes:` comment.
export const RELEASED_REMOVALS: ReadonlyArray<{ file: string; table: string; constraint: string; removes: string[] }> = [
  // D80: no record of an email that was not sent; PR #405 narrowed the CHECK.
  {
    file: '20261008200000_mail_warning_outcomes_sent_only.sql',
    table: 'public.mail_warning_outcomes',
    constraint: 'mail_warning_outcomes_outcome_check',
    removes: ['abandoned'],
  },
];

export function checkHistory(dir: string): CheckDefinition[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.flatMap((file) =>
    definitionsIn(file, readFileSync(join(dir, file), 'utf8')).map((def) => {
      const known = RELEASED_REMOVALS.find((r) => r.file === file && r.table === def.table && r.constraint === def.constraint);
      return known ? { ...def, removes: [...def.removes, ...known.removes] } : def;
    }),
  );
}

// A value an earlier definition allowed that the latest definition of the
// same constraint on the same table does not, with no marker removing it. A drop a later
// migration already repaired is not reported: only the database's final
// state matters, and a released file cannot be edited anyway.
export function findDroppedValues(history: readonly CheckDefinition[]): CheckListProblem[] {
  type State = { expected: Set<string>; lastHad: Map<string, string>; droppedBy: Map<string, string> };
  // Postgres allows one constraint name on several tables.
  const byKey = new Map<string, State>();
  for (const def of history) {
    const key = `${def.table}\u0000${def.constraint}`;
    let st = byKey.get(key);
    if (!st) {
      st = { expected: new Set(), lastHad: new Map(), droppedBy: new Map() };
      byKey.set(key, st);
    }
    const now = new Set(def.values);
    for (const v of [...st.expected]) {
      if (now.has(v)) continue;
      if (def.removes.includes(v)) {
        st.expected.delete(v);
        st.lastHad.delete(v);
        st.droppedBy.delete(v);
      } else if (!st.droppedBy.has(v)) st.droppedBy.set(v, def.file);
    }
    for (const v of def.values) {
      st.expected.add(v);
      st.lastHad.set(v, def.file);
      st.droppedBy.delete(v);
    }
  }

  const problems: CheckListProblem[] = [];
  for (const [tableAndName, st] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const [table, constraint] = tableAndName.split('\u0000');
    const groups = new Map<string, string[]>();
    for (const [value, file] of st.droppedBy) {
      const key = `${file}\u0000${st.lastHad.get(value)}`;
      groups.set(key, [...(groups.get(key) ?? []), value]);
    }
    for (const [key, dropped] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const [file, lastHadIn] = key.split('\u0000');
      problems.push({ table, constraint, file, dropped: dropped.sort(), lastHadIn });
    }
  }
  return problems;
}

export function formatCheckListProblem(p: CheckListProblem): string {
  return `${p.table} ${p.constraint} in ${p.file} drops ${p.dropped.map((v) => `'${v}'`).join(', ')} (last allowed by ${p.lastHadIn})`;
}
