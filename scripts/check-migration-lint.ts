import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lex, listValues, markerValues, type Segment } from './check-migration-check-lists';
import { get, type Ctx, type Fetcher, type Migration } from './check-migration-open-prs';
import { prAddedMigrations } from './check-migration-order';

// Review findings that kept coming back on migration PRs, as CI failures. It
// lints only the migration files a PR adds (a released file cannot change),
// and each failure says what is wrong, the one-line fix, and the escape hatch:
//
//   -- lint-allow: <rule-id> <reason>
//
// on the offending statement or directly above it. A marker without a reason
// does not count, and every marker is printed so reviewers see it. It runs from
// check-migration-prefixes.ts; `--all` lints every migration (calibration only).
//
// Statements are read with check-migration-check-lists' lexer, so text in
// strings and comments is never DDL, and a dollar-quoted body (a function or
// a DO block) is not a top-level statement.

export const RULES = [
  'definer-search-path',
  'definer-grants',
  'table-grants',
  'hosted-catalog',
  'heavy-lock',
  'hosted-counts',
] as const;
export type Rule = (typeof RULES)[number];

// `rule` is a Rule, or the unknown id a lint-allow marker names.
export type Finding = { rule: string; file: string; line: number; problem: string; fix: string };
export type Allowed = { rule: string; file: string; line: number; reason: string };
// A change whose outcome depends on the rows already on a hosted database.
export type CountTrigger = { file: string; line: number; what: string };

export type LintContext = {
  // supabase/lint/browser-grants.txt: tables the browser roles may hold a grant on.
  browserGrants: ReadonlySet<string>;
  // The definers supabase/tests/definer_grants.sql allows `authenticated` to execute.
  authenticatedDefiners: ReadonlySet<string>;
  bigTables: ReadonlySet<string>;
  // Public functions earlier migrations create, by signature (`name(argtypes)`,
  // see functionKey), and whether the latest one is a security definer. Only a
  // `create or replace` of an existing definer with the same signature keeps a
  // safe ACL; a new overload, or an invoker turned definer, keeps PUBLIC execute.
  existingFunctions: ReadonlyMap<string, boolean>;
};

// supabase/lint/big-tables.txt lists the tables a full-scan lock must not hit
// (one name per line, # comments). It lives in a data file because these names
// may only appear in source files that are their reviewed homes.
export function parseBigTables(text: string): ReadonlySet<string> {
  return new Set(
    text
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim().toLowerCase())
      .filter(Boolean),
  );
}

const CATALOG = /\b(pg_proc|pg_class|pg_policies|pg_policy|pg_namespace|pg_trigger|information_schema)\b/i;
const IDENT = String.raw`(?:"(?:[^"]|"")*"|[a-z_\u0080-￿][a-z0-9_$\u0080-￿]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

const allowSyntax = (rule: string) => `-- lint-allow: ${rule} <reason>`;

// `public.foo`, `"foo"`, `foo` -> { schema: 'public', name: 'foo' }.
export function parseName(raw: string): { schema: string; name: string } {
  const parts = [...raw.trim().matchAll(new RegExp(IDENT, 'gi'))].map((m) =>
    m[0].startsWith('"') ? m[0].slice(1, -1).replace(/""/g, '"') : m[0].toLowerCase(),
  );
  return parts.length > 1 ? { schema: parts[0], name: parts[1] } : { schema: 'public', name: parts[0] ?? '' };
}

// Splits on top-level commas (outside parentheses).
function topLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

type Statement = {
  segs: Segment[];
  // Executed text: comments become a space, a dollar body an empty literal.
  code: string;
  // The dollar-quoted bodies, with their own comments and strings removed.
  bodies: string[];
  line: number;
  markers: Array<{ rule: string; reason: string; line: number }>;
};

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const MARKER = /--[ \t]*lint-allow:[ \t]*([a-z][a-z-]*)?(?:[ \t]+([^\n]*?))?[ \t]*$/gim;

function markersIn(text: string, start: number, starts: number[]): Statement['markers'] {
  const out: Statement['markers'] = [];
  for (const m of text.matchAll(MARKER)) {
    out.push({ rule: m[1] ?? '', reason: (m[2] ?? '').trim(), line: lineAt(starts, start + (m.index ?? 0)) });
  }
  return out;
}

// The code of a dollar-quoted body, without its tag, comments and strings.
function bodyCode(dollar: string): string {
  const tag = /^\$[^$]*\$/.exec(dollar)?.[0] ?? '$$';
  const inner = dollar.slice(tag.length, dollar.endsWith(tag) ? -tag.length : undefined);
  return lex(inner)
    .map((s) => (s.kind === 'comment' ? ' ' : s.kind === 'string' ? "''" : s.kind === 'dollar' ? bodyCode(s.text) : s.text))
    .join('');
}

// Statements with their line (the first code character) and lint-allow
// markers: in the statement's comments (above it or inside it), in comments
// of its dollar body, or trailing on the line where it ends.
export function statements(sql: string): Statement[] {
  const starts = [0];
  for (let i = 0; i < sql.length; i++) if (sql[i] === '\n') starts.push(i + 1);

  const raw: Segment[][] = [];
  let current: Segment[] = [];
  for (const seg of lex(sql)) {
    if (seg.kind !== 'code') {
      current.push(seg);
      continue;
    }
    let offset = 0;
    const parts = seg.text.split(';');
    parts.forEach((part, k) => {
      if (part) current.push({ kind: 'code', text: part, start: seg.start + offset });
      offset += part.length + 1;
      if (k < parts.length - 1) {
        current.push({ kind: 'code', text: ';', start: seg.start + offset - 1 });
        raw.push(current);
        current = [];
      }
    });
  }
  if (current.some((s) => s.kind !== 'comment' && s.text.trim())) raw.push(current);
  // A comment-only remainder still carries a marker trailing the last statement.
  else if (current.length > 0) raw.push(current);

  const out: Statement[] = [];
  raw.forEach((segs, k) => {
    const first = segs.find((s) => s.kind !== 'comment' && s.text.trim());
    if (!first) return;
    const firstOffset = first.kind === 'code' ? first.start + (first.text.length - first.text.trimStart().length) : first.start;
    const code = segs.map((s) => (s.kind === 'comment' ? ' ' : s.kind === 'dollar' ? "''" : s.text)).join('');
    const markers: Statement['markers'] = [];
    segs.forEach((s, i) => {
      // A comment on the line where the previous statement ends belongs to that one.
      if (s.kind === 'comment' && !(k > 0 && leadsOnPrev(segs, i))) markers.push(...markersIn(s.text, s.start, starts));
      if (s.kind === 'dollar') markers.push(...markersIn(s.text, s.start, starts));
    });
    const next = raw[k + 1];
    if (next) {
      for (let i = 0; i < next.length; i++) {
        const s = next[i];
        if (s.kind === 'comment') {
          if (leadsOnPrev(next, i)) markers.push(...markersIn(s.text, s.start, starts));
          break;
        }
        if (s.kind !== 'code' || s.text.includes('\n')) break;
      }
    }
    out.push({
      segs,
      code,
      bodies: segs.filter((s) => s.kind === 'dollar').map((s) => bodyCode(s.text)),
      line: lineAt(starts, firstOffset),
      markers,
    });
  });
  return out;
}

function leadsOnPrev(segs: Segment[], i: number): boolean {
  return segs.slice(0, i).every((p) => p.kind === 'code' && !p.text.includes('\n'));
}

// ---------------------------------------------------------------- the rules

type Hit = { rule: Rule; line: number; problem: string; fix: string; st: Statement };

const SEARCH_PATH_ITEM = (name: string) => String.raw`(?:${name}|'${name}'|"${name}")`;
const PINNED_PATH = new RegExp(
  String.raw`\bset\s+search_path\s*(?:=|\bto\b)\s*${SEARCH_PATH_ITEM('public')}\s*,\s*${SEARCH_PATH_ITEM('pg_temp')}(?!\s*,)`,
  'i',
);

const CREATE_ROUTINE = new RegExp(String.raw`^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(${QNAME})\s*\(`, 'i');

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  bool: 'boolean',
  float8: 'double precision',
  float4: 'real',
  decimal: 'numeric',
  varchar: 'character varying',
  char: 'character',
  timestamptz: 'timestamp with time zone',
  'timestamp without time zone': 'timestamp',
  timetz: 'time with time zone',
  'time without time zone': 'time',
};
// Types spelled in several words, so their first word is not an argument name.
const MULTIWORD_TYPE = /^(?:double precision|(?:national )?char(?:acter)? varying|bit varying|(?:timestamp|time) with(?:out)? time zone|interval \w+)\b/;

// One argument's type: mode, name, default and type modifiers dropped, aliases
// resolved. Undefined for an OUT argument (not part of the signature).
function argType(arg: string): string | undefined {
  const words = arg
    .replace(/\s+default\s[\s\S]*$|\s*=[\s\S]*$/i, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/"/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  const mode = /^(in|out|inout|variadic)$/.test(words[0]) ? words.shift() : undefined;
  if (mode === 'out') return undefined;
  if (words.length > 1 && !MULTIWORD_TYPE.test(words.join(' '))) words.shift();
  const type = words.join(' ').replace(/^(?:public|pg_catalog)\s*\.\s*/, '');
  const array = /(\s*\[\s*\])+$/.exec(type)?.[0].replace(/\s/g, '') ?? '';
  const base = type.slice(0, type.length - (/(\s*\[\s*\])+$/.exec(type)?.[0].length ?? 0)).trim();
  return (TYPE_ALIASES[base] ?? base) + array;
}

// `name(type, type)`: the identity Postgres keys a function by.
export function functionKey(name: string, args: string): string {
  return `${name}(${topLevel(args).map(argType).filter((t) => t !== undefined).join(', ')})`;
}

// The argument list after the opening parenthesis at `open`.
function argList(code: string, open: number): string {
  let depth = 1;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return code.slice(open, i);
  }
  return code.slice(open);
}

type CreatedFunction = { name: string; key: string; definer: boolean };

function createdFunction(st: Statement): CreatedFunction | undefined {
  const m = CREATE_ROUTINE.exec(st.code);
  if (!m) return undefined;
  const { schema, name } = parseName(m[1]);
  if (schema !== 'public') return undefined;
  return { name, key: functionKey(name, argList(st.code, m[0].length)), definer: /\bsecurity\s+definer\b/i.test(st.code) };
}


// `args` is the argument list as written, undefined when the ACL names the
// function bare; `keys` are the signatures it resolves to (see definerRules).
type RoutineRef = { name: string; args?: string; roles: string[]; st: Statement; keys: string[] };

// `revoke|grant <privs> on function|procedure|routine a(...), b(...) from|to roles`.
const roleList = (list: string) => list.split(',').map((r) => parseName(r).name);

function routineAcl(st: Statement, verb: 'grant' | 'revoke'): RoutineRef[] | { all: string[] } | undefined {
  const dir = verb === 'grant' ? 'to' : 'from';
  const all = new RegExp(
    String.raw`^\s*${verb}\s+[\s\S]+?\s+on\s+all\s+(?:functions|routines|procedures)\s+in\s+schema\s+public\s+${dir}\s+([\s\S]+?)(?:\s+(?:cascade|restrict|granted\s+by\s+\S+|with\s+grant\s+option))?\s*;?\s*$`,
    'i',
  ).exec(st.code);
  if (all) return { all: roleList(all[1]) };
  const m = new RegExp(
    String.raw`^\s*${verb}\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:function|procedure|routine)\s+([\s\S]+?)\s+${dir}\s+([\s\S]+?)(?:\s+(?:cascade|restrict|granted\s+by\s+\S+|with\s+grant\s+option))?\s*;?\s*$`,
    'i',
  ).exec(st.code);
  if (!m) return undefined;
  const roles = roleList(m[2]);
  return topLevel(m[1]).map((item) => {
    const { schema, name } = parseName(item.replace(/\([\s\S]*$/, ''));
    const open = item.indexOf('(');
    return { name: schema === 'public' ? name : `${schema}.${name}`, args: open < 0 ? undefined : argList(item, open + 1), roles, st, keys: [] };
  });
}

// The signatures a reference names: its own, or for a bare name the one
// overload that exists (none when there are several: Postgres refuses it).
function resolveRef(name: string, args: string | undefined, existing: ReadonlyMap<string, boolean>): string[] {
  if (args !== undefined) return [functionKey(name, args)];
  const keys = [...existing.keys()].filter((key) => key.slice(0, key.indexOf('(')) === name);
  return keys.length === 1 ? keys : [];
}

const DROP_ROUTINE = new RegExp(String.raw`^\s*drop\s+(?:function|procedure|routine)\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*;?\s*$`, 'i');

const ALTER_ROUTINE = new RegExp(String.raw`^\s*alter\s+(?:function|procedure|routine)\s+(${QNAME})\s*`, 'i');

// `alter function f(...) [external] security definer|invoker`: the function
// and the mode it sets, or undefined.
function alteredMode(st: Statement, existing: ReadonlyMap<string, boolean>): { key: string; name: string; definer: boolean } | undefined {
  const m = ALTER_ROUTINE.exec(st.code);
  if (!m) return undefined;
  const { schema, name } = parseName(m[1]);
  if (schema !== 'public') return undefined;
  let rest = st.code.slice(m[0].length);
  let args: string | undefined;
  if (rest.startsWith('(')) {
    args = argList(rest, 1);
    rest = rest.slice(args.length + 2);
  }
  const mode = /\bsecurity\s+(definer|invoker)\b/i.exec(rest)?.[1].toLowerCase();
  const [key] = resolveRef(name, args, existing);
  if (!mode || !key) return undefined;
  return { key, name, definer: mode === 'definer' };
}

// Applies one statement's create, drop or security change to the public
// signatures and their mode. For a create or a change to definer, returns
// the function and its mode before (undefined: a new function).
type Replayed = { key: string; name: string; definer: boolean; prior: boolean | undefined };
function replay(st: Statement, existing: Map<string, boolean>): Replayed | undefined {
  const drop = DROP_ROUTINE.exec(st.code);
  if (drop) {
    for (const item of topLevel(drop[1])) {
      const { schema, name } = parseName(item.replace(/\([\s\S]*$/, ''));
      if (schema !== 'public') continue;
      const open = item.indexOf('(');
      for (const key of resolveRef(name, open < 0 ? undefined : argList(item, open + 1), existing)) existing.delete(key);
    }
    return undefined;
  }
  const changed = createdFunction(st) ?? alteredMode(st, existing);
  if (!changed) return undefined;
  const prior = existing.get(changed.key);
  existing.set(changed.key, changed.definer);
  return { key: changed.key, name: changed.name, definer: changed.definer, prior };
}

// Folds a migration's creates and drops into `existing`, in statement order.
export function foldFunctions(sql: string, existing: Map<string, boolean>): void {
  for (const st of statements(sql)) replay(st, existing);
}

// The definer-grants replay across the files being linted, in order. `acl`
// holds, per signature, the browser roles that can still execute it since its
// latest create: a new function starts with Supabase's default grants
// (public, anon, authenticated), a drop removes the entry, a `create or
// replace` keeps it, and a revoke or grant changes it only after that create.
// A pre-existing function whose ACL this replay never saw starts as default.
type Acl = Map<string, 'default' | 'granted'>;
export type DefinerReplay = {
  existing: Map<string, boolean>;
  acl: Map<string, Acl>;
  // New or invoker-replaced definers, checked against their ACL once every file ran.
  pending: Array<{ file: string; key: string; name: string; was: boolean | undefined; acl: Acl; st: Statement }>;
};

const BROWSER_ROLES = ['public', 'anon', 'authenticated'];
const defaultAcl = (): Acl => new Map(BROWSER_ROLES.map((r) => [r, 'default' as const]));

export function definerReplay(existing: ReadonlyMap<string, boolean>): DefinerReplay {
  return { existing: new Map(existing), acl: new Map(), pending: [] };
}

function aclOf(replay: DefinerReplay, key: string): Acl | undefined {
  if (!replay.existing.has(key)) return undefined;
  if (!replay.acl.has(key)) replay.acl.set(key, defaultAcl());
  return replay.acl.get(key);
}

function definerRules(stmts: Statement[], ctx: LintContext, replayState: DefinerReplay, file: string): Hit[] {
  const hits: Hit[] = [];
  const grants: RoutineRef[] = [];
  const { existing } = replayState;
  const resolve = (ref: RoutineRef) => resolveRef(ref.name, ref.args, existing);
  for (const st of stmts) {
    const fn = replay(st, existing);
    if (DROP_ROUTINE.test(st.code)) for (const key of replayState.acl.keys()) if (!existing.has(key)) replayState.acl.delete(key);
    if (fn) {
      // A new function gets a fresh default ACL; a replace or an alter keeps the one it had.
      if (fn.prior === undefined) replayState.acl.set(fn.key, defaultAcl());
      if (fn.definer && fn.prior !== true) {
        replayState.pending.push({ file, key: fn.key, name: fn.name, was: fn.prior, acl: aclOf(replayState, fn.key)!, st });
      }
    }
    // A schema-wide revoke covers the functions that exist at this point.
    const r = routineAcl(st, 'revoke');
    const revokes = !r ? [] : 'all' in r ? [...existing.keys()].map((key) => ({ key, roles: r.all })) : r.flatMap((ref) => resolve(ref).map((key) => ({ key, roles: ref.roles })));
    for (const { key, roles } of revokes) for (const role of roles) aclOf(replayState, key)?.delete(role);
    const g = routineAcl(st, 'grant');
    if (g && 'all' in g) {
      // Re-opens every definer in the schema, earlier files' included.
      const open = g.all.filter((role) => role === 'public' || role === 'anon' || role === 'authenticated');
      if (open.length > 0) {
        hits.push({
          rule: 'definer-grants',
          line: st.line,
          problem: `grants every function in the schema to ${open.join(', ')}, which re-opens every security definer there to the browser roles.`,
          fix: 'grant execute on the named functions one by one, to the role that calls each.',
          st,
        });
      }
    } else if (g) {
      for (const ref of g) {
        const keys = resolve(ref);
        grants.push({ ...ref, keys });
        for (const key of keys) for (const role of ref.roles) if (BROWSER_ROLES.includes(role)) aclOf(replayState, key)?.set(role, 'granted');
      }
    }
  }

  for (const st of stmts) {
    const created = createdFunction(st);
    if (!created?.definer) continue;
    const { name } = created;
    if (!PINNED_PATH.test(st.code)) {
      hits.push({
        rule: 'definer-search-path',
        line: st.line,
        problem: `security definer ${name}() does not pin the search path to public, pg_temp (without pg_temp a caller's temp table can shadow a public one; supabase/tests/definer_grants.sql fails it).`,
        fix: 'add `set search_path = public, pg_temp` to the function header.',
        st,
      });
    }
  }

  // Stateless: whichever file created the function and whatever its mode, an
  // execute grant to a browser role is reviewed here.
  for (const g of grants) {
    const open = g.roles.filter((r) => r === 'public' || r === 'anon');
    if (open.length > 0) {
      hits.push({
        rule: 'definer-grants',
        line: g.st.line,
        problem: `${g.name}() is granted to ${open.join(', ')}: anyone holding the publishable key could call it (and if it is, or becomes, a security definer, with its owner's rights).`,
        fix: `grant execute on function ${g.name} to service_role; (or authenticated, if it acts on auth.uid() and checks the caller itself).`,
        st: g.st,
      });
    }
    if (g.roles.includes('authenticated') && !ctx.authenticatedDefiners.has(g.name)) {
      hits.push({
        rule: 'definer-grants',
        line: g.st.line,
        problem: `${g.name}() is granted to authenticated but is not in the allowlist of supabase/tests/definer_grants.sql (that test fails CI on a definer granted to authenticated off the list).`,
        fix: `add '${g.name}' to that allowlist with a comment on why the signed-in role calls it and how it checks the caller, or grant it to service_role instead.`,
        st: g.st,
      });
    }
  }
  return hits;
}

const NOT_TABLE = /^(?:function|functions|procedure|procedures|routine|routines|schema|sequence|sequences|type|domain|language|foreign|large|database|tablespace|parameter)\b/i;

function tableGrantRule(stmts: Statement[], ctx: LintContext): Hit[] {
  const hits: Hit[] = [];
  for (const st of stmts) {
    const m = /^\s*grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?\s*;?\s*$/i.exec(st.code);
    if (!m || /\bon\b/i.test(m[1].replace(/\([^)]*\)/g, ''))) continue;
    // PUBLIC reaches both browser roles.
    const roles = roleList(m[3]).filter((r) => r === 'anon' || r === 'authenticated' || r === 'public');
    if (roles.length === 0) continue;
    const target = m[2].trim();
    if (/^all\s+tables\s+in\s+schema\b/i.test(target)) {
      hits.push({
        rule: 'table-grants',
        line: st.line,
        problem: `grants every table in the schema to ${roles.join(', ')}, including tables RLS closes by having no policy (TRUNCATE ignores RLS).`,
        fix: 'grant the named tables one by one, each listed in supabase/lint/browser-grants.txt.',
        st,
      });
      continue;
    }
    if (NOT_TABLE.test(target)) continue;
    for (const item of topLevel(target.replace(/^table\s+/i, ''))) {
      const { schema, name } = parseName(item);
      if (schema !== 'public' || ctx.browserGrants.has(name)) continue;
      hits.push({
        rule: 'table-grants',
        line: st.line,
        problem: `grants ${name} to ${roles.join(', ')}, and ${name} is not in supabase/lint/browser-grants.txt (the browser roles reach every granted table through /rest/v1, so RLS is all that stands between them and its rows).`,
        fix: `add the line \`${name}: <who reads it from the browser, and the RLS policy that limits it>\` to supabase/lint/browser-grants.txt.`,
        st,
      });
    }
  }
  return hits;
}

function hostedCatalogRule(stmts: Statement[]): Hit[] {
  const hits: Hit[] = [];
  for (const st of stmts) {
    const isDo = /^\s*do\b/i.test(st.code);
    for (const body of st.bodies) {
      const loops = [...body.matchAll(/\bfor\s+[\s\S]+?\bin\b([\s\S]+?)\bloop\b/gi)].some((m) => CATALOG.test(m[1]));
      const hit = isDo ? CATALOG.exec(body) : loops ? CATALOG.exec(body) : null;
      if (!hit) continue;
      hits.push({
        rule: 'hosted-catalog',
        line: st.line,
        problem: `${isDo ? 'a DO block' : 'a loop'} reads ${hit[1].toLowerCase()}, which on a hosted database also lists Supabase's own objects (#542: a loop reached rls_auto_enable() and stopped dev's migrations for 3 hours).`,
        fix: 'name the objects this migration creates (an array of names or regprocedure casts) instead of scanning the catalog, or filter the scan to them.',
        st,
      });
      break;
    }
  }
  return hits;
}

type Alter = { table: string; actions: string[]; st: Statement };

function alters(stmts: Statement[]): Alter[] {
  const out: Alter[] = [];
  for (const st of stmts) {
    const m = new RegExp(String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QNAME})`, 'i').exec(st.code);
    if (!m) continue;
    const { schema, name } = parseName(m[1]);
    if (schema !== 'public') continue;
    out.push({ table: name, actions: topLevel(st.code.slice(m[0].length).replace(/;\s*$/, '')), st });
  }
  return out;
}

function createdTables(stmts: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const st of stmts) {
    const m = new RegExp(String.raw`^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${QNAME})`, 'i').exec(st.code);
    if (m) out.add(parseName(m[1]).name);
  }
  return out;
}

const INDEX = new RegExp(
  String.raw`^\s*create\s+(unique\s+)?index\s+(concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${IDENT}\s+)?on\s+(?:only\s+)?(${QNAME})`,
  'i',
);
const ADD_CONSTRAINT = new RegExp(String.raw`^add\s+(?:constraint\s+(${IDENT})\s+)?(check|foreign\s+key|unique|primary\s+key|exclude)\b`, 'i');

// How `supabase db push` runs a file (CLI 2.116.0, the version CI pins:
// apps/cli/src/legacy/shared/legacy-migration-apply.ts, execMigrationBatch):
// the statements go in one extended-protocol batch with a single Sync, so one
// implicit transaction, except the ones that cannot run in a transaction
// (CREATE/DROP INDEX CONCURRENTLY, REINDEX CONCURRENTLY, VACUUM, CLUSTER, ALTER
// SYSTEM). For each of those the batch so far is committed, the statement runs
// on its own, and a new batch starts.
const TRANSACTION_NOTE = '`supabase db push` runs a migration file as one transaction (a statement that cannot run in one, like CREATE INDEX CONCURRENTLY, runs on its own)';
const CONCURRENT_FIX =
  'put `create index concurrently if not exists` alone in its own migration file (db push runs it outside a transaction; if it fails, drop the invalid index it leaves before re-running, or `if not exists` skips it).';

function heavyLockRule(stmts: Statement[], ctx: LintContext): Hit[] {
  const hits: Hit[] = [];
  const created = createdTables(stmts);
  for (const st of stmts) {
    const m = INDEX.exec(st.code);
    if (!m) continue;
    const table = parseName(m[3]).name;
    if (m[2]) {
      // Alone in its file it is the safe form. With other statements, db push
      // commits the ones before it first, so a failure leaves them applied
      // while the file stays unrecorded and re-runs from the top.
      if (stmts.length > 1) {
        hits.push({
          rule: 'heavy-lock',
          line: st.line,
          problem: 'CREATE INDEX CONCURRENTLY shares its file with other statements: `supabase db push` commits the statements before it, then runs it outside a transaction, so if it fails the file is half applied and re-runs from the top.',
          fix: 'move it to its own migration file.',
          st,
        });
      }
    } else if (ctx.bigTables.has(table) && !created.has(table)) {
      hits.push({
        rule: 'heavy-lock',
        line: st.line,
        problem: `creates an index on ${table}, a big table: the build holds a SHARE lock that blocks every write to it until the scan ends.`,
        fix: CONCURRENT_FIX,
        st,
      });
    }
  }
  for (const a of alters(stmts)) {
    if (!ctx.bigTables.has(a.table) || created.has(a.table)) continue;
    for (const action of a.actions) {
      const add = ADD_CONSTRAINT.exec(action);
      if (add) {
        const kind = add[2].toLowerCase().replace(/\s+/g, ' ');
        if ((kind === 'check' || kind === 'foreign key') && /\bnot\s+valid\b/i.test(action)) {
          const name = add[1] ? parseName(add[1]).name : undefined;
          const validated = name && alters(stmts).find((b) => b.table === a.table && b.actions.some((x) => new RegExp(String.raw`^validate\s+constraint\s+"?${name}"?\s*$`, 'i').test(x)));
          if (validated) {
            hits.push({
              rule: 'heavy-lock',
              line: validated.st.line,
              problem: `validates ${name} on ${a.table} in the file that added it NOT VALID: ${TRANSACTION_NOTE}, so the ADD's ACCESS EXCLUSIVE lock is still held during the full scan.`,
              fix: 'move `alter table ... validate constraint` to a later migration file, where it takes only a SHARE UPDATE EXCLUSIVE lock.',
              st: validated.st,
            });
          }
          continue;
        }
        hits.push({
          rule: 'heavy-lock',
          line: a.st.line,
          problem:
            kind === 'check' || kind === 'foreign key'
              ? `adds a ${kind.toUpperCase()} to ${a.table}, a big table, without NOT VALID: every existing row is checked under an ACCESS EXCLUSIVE lock that blocks reads and writes.`
              : `adds a ${kind.toUpperCase()} constraint to ${a.table}, a big table: it builds an index under an ACCESS EXCLUSIVE lock that blocks reads and writes.`,
          fix:
            kind === 'check' || kind === 'foreign key'
              ? 'add it `not valid` here and `alter table ... validate constraint <name>` in a later migration file (a file is one transaction, so the ADD\'s lock lasts until the file ends).'
              : 'build the index with `create unique index concurrently` alone in an earlier migration file, then `add constraint <name> unique using index <index>` here.',
          st: a.st,
        });
      }
    }
  }
  return hits;
}

// A value-list CHECK this file drops and re-adds under the same name, with no
// `-- check-removes:` marker: check-migration-check-lists already fails a
// restatement that drops a value, so the new list holds every row the old did.
function isWidening(a: Alter, action: string, rawName: string | undefined, stmts: Statement[]): boolean {
  if (!rawName) return false;
  const body = /\bcheck\s*\(([\s\S]*)\)/i.exec(action)?.[1];
  if (!body || !listValues(body)) return false;
  const name = parseName(rawName).name;
  const dropsIt = (x: Alter) =>
    x.table === a.table && x.actions.some((act) => new RegExp(String.raw`^drop\s+constraint\s+(?:if\s+exists\s+)?"?${name}"?\s*$`, 'i').test(act));
  const at = stmts.indexOf(a.st);
  const drop = alters(stmts.slice(0, at + 1)).find(dropsIt);
  if (!drop) return false;
  const raw = (st: Statement) => st.segs.map((s) => s.text).join('');
  return markerValues(raw(a.st)).length === 0 && markerValues(raw(drop.st)).length === 0;
}

// A unique index whose columns this file adds: every existing row holds the
// default there, so only a constant default could collide (rare; say so).
function onNewColumns(index: Statement, table: string, stmts: Statement[]): boolean {
  const cols = /\bon\s+[^(]+?(?:\s+using\s+\w+)?\s*\(([^)]*)\)/i.exec(index.code)?.[1];
  if (!cols) return false;
  const added = new Set(
    alters(stmts)
      .filter((a) => a.table === table)
      .flatMap((a) => a.actions)
      .map((act) => new RegExp(String.raw`^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})\s+(?!constraint\b)`, 'i').exec(act)?.[1])
      .filter((n): n is string => !!n && !/^(constraint|check|unique|primary|foreign|exclude)$/i.test(n))
      .map((n) => parseName(n).name),
  );
  return cols.split(',').every((c) => added.has(parseName(c.trim().split(/\s+/)[0]).name));
}

// Statements whose outcome depends on the rows a hosted database already
// holds: they can fail there (or change rows) while passing on CI's empty one.
export function countTriggers(stmts: Statement[]): Array<{ line: number; what: string; st: Statement }> {
  const out: Array<{ line: number; what: string; st: Statement }> = [];
  const created = createdTables(stmts);
  for (const st of stmts) {
    const idx = INDEX.exec(st.code);
    if (idx?.[1] && !created.has(parseName(idx[3]).name) && !onNewColumns(st, parseName(idx[3]).name, stmts)) {
      out.push({ line: st.line, what: `a unique index on ${parseName(idx[3]).name}`, st });
    }
    if (/^\s*(?:with\b[\s\S]*?\)\s*)?(update|delete)\b/i.test(st.code)) {
      out.push({ line: st.line, what: `${/^\s*(?:with\b[\s\S]*?\)\s*)?(update|delete)/i.exec(st.code)![1].toUpperCase()} of existing rows`, st });
    } else if (/^\s*do\b/i.test(st.code) && st.bodies.some((b) => /\bupdate\s+[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set\b|\bdelete\s+from\b/i.test(b))) {
      out.push({ line: st.line, what: 'a DO block that updates or deletes rows', st });
    }
  }
  for (const a of alters(stmts)) {
    if (created.has(a.table)) continue;
    for (const action of a.actions) {
      const add = ADD_CONSTRAINT.exec(action);
      if (/^alter\s+(?:column\s+)?\S+\s+set\s+not\s+null\b/i.test(action)) out.push({ line: a.st.line, what: `SET NOT NULL on ${a.table}`, st: a.st });
      else if (/^validate\s+constraint\b/i.test(action)) out.push({ line: a.st.line, what: `a VALIDATE CONSTRAINT on ${a.table}`, st: a.st });
      else if (add && !/\bnot\s+valid\b/i.test(action) && add[2].toLowerCase() !== 'exclude' && !isWidening(a, action, add[1], stmts)) {
        out.push({ line: a.st.line, what: `a validated ${add[2].toUpperCase().replace(/\s+/g, ' ')} on ${a.table}`, st: a.st });
      }
    }
  }
  return out.sort((x, y) => x.line - y.line);
}

export type FileLint = { findings: Finding[]; allowed: Allowed[]; counts: CountTrigger[] };

// A definer whose ACL, once every file ran, still holds a browser role's
// default execute (a grant to authenticated is the allowlist check's business).
function pendingDefinerHits(replayState: DefinerReplay): Array<{ file: string; hit: Hit }> {
  const out: Array<{ file: string; hit: Hit }> = [];
  for (const p of replayState.pending) {
    // Dropped (or dropped and recreated) since: the later create is its own entry.
    if (replayState.acl.get(p.key) !== p.acl) continue;
    const missing = BROWSER_ROLES.filter((role) => p.acl.get(role) === 'default');
    if (missing.length === 0) continue;
    out.push({
      file: p.file,
      hit: {
        rule: 'definer-grants',
        line: p.st.line,
        problem: `security definer ${p.key} is not revoked from ${missing.join(', ')} after it is created${p.was === false ? ' (it replaces an invoker, whose ACL kept PUBLIC execute)' : ''} (a definer runs with its owner's rights, and any role that can execute it calls it through /rest/v1/rpc).`,
        fix: `after the create: \`revoke all on function ${p.name} from public, anon, authenticated; grant execute on function ${p.name} to service_role;\` (or to the one role that calls it).`,
        st: p.st,
      },
    });
  }
  return out;
}

export function lintMigration(file: string, sql: string, ctx: LintContext): FileLint {
  return lintMigrations([{ file, sql }], ctx);
}

// Lints files in order as one change: a definer one file creates may be
// revoked by a later one, and each file sees the functions earlier ones made.
export function lintMigrations(files: Array<{ file: string; sql: string }>, ctx: LintContext): FileLint {
  const replayState = definerReplay(ctx.existingFunctions);
  const parsed = files.map(({ file, sql }) => ({ file, stmts: statements(sql) }));
  const hits: Array<{ file: string; hit: Hit }> = [];
  for (const { file, stmts } of parsed) {
    for (const hit of [...definerRules(stmts, ctx, replayState, file), ...tableGrantRule(stmts, ctx), ...hostedCatalogRule(stmts), ...heavyLockRule(stmts, ctx)]) hits.push({ file, hit });
  }
  hits.push(...pendingDefinerHits(replayState));
  const findings: Finding[] = [];
  const allowed: Allowed[] = [];
  const counts: CountTrigger[] = [];
  const seen = new Set<string>();
  const allow = (file: string, rule: Rule, st: Statement) => {
    const valid = st.markers.find((m) => m.rule === rule && m.reason);
    if (!valid) return false;
    const key = `${file}:${rule}:${valid.line}`;
    if (!seen.has(key)) allowed.push({ rule, file, line: valid.line, reason: valid.reason });
    seen.add(key);
    return true;
  };
  for (const { file, hit: h } of hits) {
    if (allow(file, h.rule, h.st)) continue;
    const bare = h.st.markers.some((m) => m.rule === h.rule && !m.reason);
    findings.push({
      rule: h.rule,
      file,
      line: h.line,
      problem: bare ? `${h.problem} (its lint-allow marker has no reason, so it does not count)` : h.problem,
      fix: h.fix,
    });
  }
  for (const { file, stmts } of parsed) {
    for (const t of countTriggers(stmts)) {
      if (!allow(file, 'hosted-counts', t.st)) counts.push({ file, line: t.line, what: t.what });
    }
    for (const st of stmts) {
      for (const m of st.markers) {
        if (!(RULES as readonly string[]).includes(m.rule)) {
          findings.push({
            rule: m.rule || '(none)',
            file,
            line: m.line,
            problem: `lint-allow names an unknown rule "${m.rule}", so it allows nothing.`,
            fix: `use one of: ${RULES.join(', ')}.`,
          });
        }
      }
    }
  }
  const order = new Map(files.map(({ file }, i) => [file, i]));
  findings.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0) || a.line - b.line);
  return { findings, allowed, counts };
}

export function formatFinding(f: Finding): string {
  const rule = (RULES as readonly string[]).includes(f.rule) ? f.rule : '<rule-id>';
  return `[${f.rule}] ${f.file}:${f.line} ${f.problem}\n     Fix: ${f.fix}\n     Or, if it is deliberate: ${allowSyntax(rule)}`;
}

// ---------------------------------------------------------- the reviewed lists

// `table: reason` per line; `#` starts a comment. An entry without a reason is
// a problem: the file is the review record.
export function parseBrowserGrants(text: string): { tables: Set<string>; problems: string[] } {
  const tables = new Set<string>();
  const problems: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^([a-z_][a-z0-9_]*)\s*:\s*(\S.*)$/i.exec(line);
    if (!m) problems.push(`supabase/lint/browser-grants.txt:${i + 1} needs \`table: reason\`, got "${line}"`);
    else tables.add(m[1].toLowerCase());
  });
  return { tables, problems };
}

// The names in definer_grants.sql's `p.proname <> all (array[...])` allowlist.
// The list sits in a DO block, so dollar bodies are read too.
export function definerAllowlist(sql: string): Set<string> {
  const names = new Set<string>();
  let state: 'before' | 'in' | 'done' = 'before';
  const walk = (text: string) => {
    for (const seg of lex(text)) {
      if (state === 'done') return;
      if (seg.kind === 'dollar') walk(seg.text.replace(/^\$[^$]*\$/, '').replace(/\$[^$]*\$$/, ''));
      else if (seg.kind === 'code') {
        if (state === 'before' && /proname\s*<>\s*all\s*\(\s*array\s*\[/i.test(seg.text)) state = 'in';
        else if (state === 'in' && seg.text.includes(']')) state = 'done';
      } else if (state === 'in' && seg.kind === 'string') names.add(seg.text.slice(1, -1));
    }
  };
  walk(sql);
  return names;
}

// `exclude`: the files being linted, whose functions are not "existing".
export function loadContext(exclude: ReadonlySet<string> = new Set(), root = '.'): { ctx: LintContext; problems: string[] } {
  const grantsPath = join(root, 'supabase/lint/browser-grants.txt');
  const grants = parseBrowserGrants(existsSync(grantsPath) ? readFileSync(grantsPath, 'utf8') : '');
  const definers = definerAllowlist(readFileSync(join(root, 'supabase/tests/definer_grants.sql'), 'utf8'));
  const bigTables = parseBigTables(readFileSync(join(root, 'supabase/lint/big-tables.txt'), 'utf8'));
  const dir = join(root, MIGRATIONS_DIR);
  const existingFunctions = new Map<string, boolean>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql') && !exclude.has(f)).sort()) {
    foldFunctions(readFileSync(join(dir, f), 'utf8'), existingFunctions);
  }
  return {
    ctx: { browserGrants: grants.tables, authenticatedDefiners: definers, bigTables, existingFunctions },
    problems: grants.problems,
  };
}

// ------------------------------------------------------------- hosted counts

// A `Hosted counts:` line with content: on the line, or on the lines under it
// up to a blank line. The content holds a count (a digit) or `none` with a
// reason, so an empty heading does not pass.
export function hasHostedCountsLine(body: string | null | undefined): boolean {
  const m = /^[ \t]*(?:[-*>][ \t]*)?\**Hosted counts:\**([^\n]*(?:\n[ \t]*\S[^\n]*)*)/m.exec(body ?? '');
  if (!m) return false;
  const content = m[1].replace(/\*\*/g, '');
  return /\d/.test(content) || /\bnone\b\W+\w+/i.test(content);
}

const COUNTS_FIX =
  'add a line starting `Hosted counts:` to the PR body with the query you ran on each hosted database (dev, staging, production) and its result, e.g. `Hosted counts: dev 0 duplicates, prod 0 duplicates (select key, count(*) from t group by key having count(*) > 1)`; then re-run this job.';

export async function checkHostedCounts(input: {
  counts: CountTrigger[];
  ci: boolean;
  repo?: string;
  token?: string;
  pr?: number;
  fetcher?: Fetcher;
  log: (line: string) => void;
}): Promise<string[]> {
  if (input.counts.length === 0) return [];
  const list = input.counts.map((c) => `${c.file}:${c.line} ${c.what}`);
  if (!input.ci) {
    input.log(`ℹ️  [hosted-counts] These change or check rows a hosted database already holds; the PR body will need a \`Hosted counts:\` line:\n${list.map((l) => `   - ${l}`).join('\n')}`);
    return [];
  }
  if (!input.repo || !input.token || input.pr === undefined) {
    input.log('⚠️  [hosted-counts] skipped: no PR number, repository or token to read the PR body.');
    return [];
  }
  let body: string | null | undefined;
  try {
    const ctx: Ctx = { repo: input.repo, token: input.token, fetcher: input.fetcher ?? (fetch as Fetcher) };
    body = ((await get(ctx, `/repos/${input.repo}/pulls/${input.pr}`)) as { body?: string | null }).body;
  } catch (error) {
    input.log(`⚠️  [hosted-counts] skipped, the GitHub API failed reading the PR body (${error instanceof Error ? error.message : String(error)}).`);
    return [];
  }
  if (hasHostedCountsLine(body)) {
    input.log(`✅ [hosted-counts] The PR body carries a Hosted counts: line for ${list.length} row-dependent change(s).`);
    return [];
  }
  return input.counts.map(
    (c) =>
      `[hosted-counts] ${c.file}:${c.line} ${c.what} depends on the rows a hosted database already holds, and the PR body has no \`Hosted counts:\` line (CI's database is empty, so only the hosted counts show whether it fails or what it changes).\n     Fix: ${COUNTS_FIX}\n     Or, if it is deliberate: ${allowSyntax('hosted-counts')}`,
  );
}

// ------------------------------------------------------------------ runners

const MIGRATIONS_DIR = 'supabase/migrations';

export type LintInput = {
  base: string;
  ci: boolean;
  pr?: number;
  repo?: string;
  token?: string;
  fetcher?: Fetcher;
  readOwn?: (base: string) => Migration[];
  readFile?: (name: string) => string | undefined;
  context?: { ctx: LintContext; problems: string[] };
  log?: (line: string) => void;
};

// Lints the migrations a PR adds. Returns the failures; missing data (API
// down, base not fetched) is a warning, never a failure.
export async function lintAddedMigrations(input: LintInput): Promise<string[]> {
  const log = input.log ?? console.log;
  const ctx: Ctx | undefined =
    input.repo && input.token ? { repo: input.repo, token: input.token, fetcher: input.fetcher ?? (fetch as Fetcher) } : undefined;
  const own = await prAddedMigrations({ base: input.base, pr: input.pr, ctx, readOwn: input.readOwn, log }, 'Migration lint');
  if (!own || own.length === 0) return [];
  const readFile =
    input.readFile ??
    ((name: string) => {
      const path = join(MIGRATIONS_DIR, name);
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    });
  const { ctx: lintCtx, problems } = input.context ?? loadContext(new Set(own.map((m) => m.name)));
  const findings: Finding[] = [];
  const allowed: Allowed[] = [];
  const counts: CountTrigger[] = [];
  const names = own.map((m) => m.name).sort();
  // The added files run in filename order as one change (see lintMigrations).
  const files = names.flatMap((name) => {
    const sql = readFile(name);
    return sql === undefined ? [] : [{ file: `${MIGRATIONS_DIR}/${name}`, sql }];
  });
  const r = lintMigrations(files, lintCtx);
  findings.push(...r.findings);
  allowed.push(...r.allowed);
  counts.push(...r.counts);
  const countProblems = await checkHostedCounts({ counts, ci: input.ci, repo: input.repo, token: input.token, pr: input.pr, fetcher: input.fetcher, log });
  if (allowed.length > 0) {
    log(`ℹ️  lint-allow markers in the ${names.length} migration file(s) this branch adds:`);
    for (const a of allowed) log(`   - [${a.rule}] ${a.file}:${a.line} ${a.reason}`);
  }
  const out = [...problems, ...findings.map(formatFinding), ...countProblems];
  if (out.length === 0) log(`✅ The ${names.length} migration file(s) this branch adds pass the migration lint (${RULES.join(', ')}).`);
  return out;
}

// Calibration: lints every migration (not enforced) and counts per rule.
function lintAll(): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const base = loadContext(new Set(files)).ctx;
  const existing = new Map<string, boolean>();
  const byRule = new Map<string, Set<string>>();
  const add = (rule: string, file: string) => byRule.set(rule, new Set([...(byRule.get(rule) ?? []), file]));
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const r = lintMigration(file, sql, { ...base, existingFunctions: new Map(existing) });
    foldFunctions(sql, existing);
    for (const f of r.findings) {
      add(f.rule, file);
      if (process.argv.includes('--verbose')) console.log(formatFinding(f));
    }
    if (r.counts.length) add('hosted-counts', file);
    for (const a of r.allowed) console.log(`allowed [${a.rule}] ${file}:${a.line} ${a.reason}`);
  }
  console.log(`${files.length} migration files`);
  for (const rule of RULES) {
    const set = byRule.get(rule) ?? new Set();
    console.log(`${rule}: ${set.size} file(s)${set.size ? ` (latest: ${[...set].sort().at(-1)})` : ''}`);
  }
}

if (process.argv[1]?.endsWith('check-migration-lint.ts') && process.argv.includes('--all')) lintAll();
