// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #296: the invite functions must keep deciding authority through the permission
 * system. Two later full redefinitions (20260929120000, 20261002100000) silently
 * overwrote the in-place patches 0814 and 0816 had applied, so `create_invite`
 * went back to reading the `users.can_invite` projection and dropped the
 * external client director's deal-less branch. The in-place patching pattern is
 * the fragility; this guard is the other half of the fix.
 *
 * It reads the LEXICALLY LATEST migration that defines each function and
 * asserts the properties the restore (20261003100000) put there. The live check
 * in supabase/tests/invite_authority_parity.sql asserts the same properties on
 * pg_get_functiondef, which also catches a redefinition this file-order
 * heuristic misses (a patch applied through `execute replace(...)`, say).
 *
 * Each matcher is exported-shaped and self-tested on inline probe bodies below,
 * so a matcher that always passes cannot hide behind a good migration.
 */

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');

/**
 * SQL with `--` line comments and (nested) block comments removed. Single-quoted
 * strings are copied through untouched, so a `--` inside a literal survives and a
 * quote inside a comment cannot open a string. A commented-out predicate must not
 * satisfy a matcher.
 */
export function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += ' ';
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The first dollar-quote delimiter (`$$` or `$tag$`) at or after `from`. */
const DOLLAR_QUOTE = /\$(?:[A-Za-z_]\w*)?\$/g;

/** The text between a definition's opening and closing dollar-quote delimiter. */
export function dollarBody(definition: string): string | null {
  DOLLAR_QUOTE.lastIndex = 0;
  const open = DOLLAR_QUOTE.exec(definition);
  if (!open) return null;
  const from = open.index + open[0].length;
  const close = definition.indexOf(open[0], from);
  return close < 0 ? null : definition.slice(from, close);
}

/**
 * The body of the last `create [or replace] function <name>(` in the latest file
 * that has one, comments stripped. A definition is `create ... $tag$ body $tag$`
 * for any tag, not only `$$`.
 */
export function latestDefinition(
  name: string,
  files: { file: string; sql: string }[],
): { file: string; body: string } | null {
  // `name(` directly: `create_invite(` does not match `create_invite_with_affiliation(`.
  const start = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${name}\\s*\\(`, 'gi');
  let found: { file: string; body: string } | null = null;
  for (const { file, sql: raw } of files) {
    const sql = stripSqlComments(raw);
    let last: RegExpExecArray | null = null;
    for (let m = start.exec(sql); m; m = start.exec(sql)) last = m;
    if (!last) continue;
    // A plpgsql body is one dollar-quoted string. The definition ends at the
    // delimiter that closes the one it opens with.
    DOLLAR_QUOTE.lastIndex = last.index;
    const open = DOLLAR_QUOTE.exec(sql);
    const close = open ? sql.indexOf(open[0], open.index + open[0].length) : -1;
    found = { file, body: sql.slice(last.index, close < 0 ? undefined : close + open![0].length) };
  }
  return found;
}

const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const RESOLVER = /from\s+public\.app_company_effective_permissions\(\s*[\w.]+\s*,\s*[\w.]+\s*\)\s+\w+\s+where\s+\w+\.permission_key\s*=\s*'company:invites:send'/;
const NO_PROJECTION = /\.can_invite\b/;
const RECORDS_CROSSING = /insert\s+into\s+invites\s*\([^)]*\bprovisioning_crossing\b/;

/** Problems with a create_invite body. Empty means the restore is intact. */
export function createInviteProblems(body: string): string[] {
  const problems: string[] = [];
  if (!RESOLVER.test(body)) problems.push('does not read company:invites:send through app_company_effective_permissions');
  if (NO_PROJECTION.test(body)) problems.push('reads the users.can_invite projection');
  if (!/p_deal_id\s+is\s+null\s+and\s+v_company_type\s*=\s*'client'/.test(body)) {
    problems.push('lost the external client director deal-less branch');
  }
  if (!/if\s+not\s+coalesce\(\s*v_actor\.status\s*=\s*'active'\s*,\s*false\s*\)\s+then\s+raise\s+exception\s+'not_permitted'/.test(body)) {
    problems.push('lost the actor-active gate');
  }
  if (!/pg_advisory_xact_lock_shared\(\s*hashtextextended\(\s*p_company_id::text\s*,\s*160\s*\)\s*\)/.test(body)) {
    problems.push('does not take the shared company access lock');
  }
  if (!/v_provisioning_crossing\s*:=\s*true/.test(body) || !RECORDS_CROSSING.test(body)) {
    problems.push('does not record the provisioning crossing on the invite');
  }
  return problems;
}

/** Problems with the seat helper both acceptance paths share. */
export function seatHelperProblems(body: string): string[] {
  const problems: string[] = [];
  if (!RESOLVER.test(body)) problems.push('does not read company:invites:send through app_company_effective_permissions');
  if (NO_PROJECTION.test(body)) problems.push('reads the users.can_invite projection');
  if (!/p_invite\.deal_id\s+is\s+null\s+and\s+v_company_type\s*=\s*'client'/.test(body)) {
    problems.push('lost the external client director deal-less branch');
  }
  if (!/coalesce\(\s*v_inviter\.status\s*=\s*'active'\s*,\s*false\s*\)/.test(body)) {
    problems.push('lost the inviter-active check');
  }
  if (!/pg_advisory_xact_lock_shared\(\s*hashtextextended\(\s*p_invite\.company_id::text\s*,\s*160\s*\)\s*\)/.test(body)) {
    problems.push('does not take the shared company access lock');
  }
  if (!/security\s+definer/i.test(body)) problems.push('is not security definer');
  // A crossing stands on the decision recorded at issue. Re-asking whether the
  // tenant is unprovisioned refuses the admin's other bootstrap invitations.
  if (!/coalesce\(\s*p_invite\.provisioning_crossing\s*,\s*false\s*\)/.test(body)) {
    problems.push('does not honour the recorded provisioning crossing');
  }
  if (/tenant_is_unprovisioned/.test(body)) problems.push('re-checks tenant_is_unprovisioned at acceptance');
  return problems;
}

/** Problems with an acceptance function: it must call the helper and raise inviter_not_authorized. */
export function acceptProblems(body: string): string[] {
  const problems: string[] = [];
  if (!/not\s+public\.app_invite_seat_authorized\(\s*v_invite\s*\)\s+then\s+raise\s+exception\s+'inviter_not_authorized'/.test(body)) {
    problems.push('does not refuse through app_invite_seat_authorized');
  }
  if (NO_PROJECTION.test(body)) problems.push('reads the users.can_invite projection');
  return problems;
}

const REVOKE_SEAT_HELPER =
  /revoke\s+all\s+on\s+function\s+public\.app_invite_seat_authorized\(\s*(?:public\.)?invites\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i;
const GRANT_SEAT_HELPER_TO_API =
  /grant\s+execute\s+on\s+function\s+(?:public\.)?app_invite_seat_authorized\s*\([^)]*\)\s+to\s+[^;]*\b(?:anon|authenticated)\b/i;

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), 'utf8') }));

describe('the latest invite function definitions keep the permission-system authority (#296)', () => {
  it('create_invite', () => {
    const def = latestDefinition('create_invite', files);
    expect(def, 'no migration defines create_invite').not.toBeNull();
    expect(createInviteProblems(def!.body), `in ${def!.file}`).toEqual([]);
  });

  it('app_invite_seat_authorized', () => {
    const def = latestDefinition('app_invite_seat_authorized', files);
    expect(def, 'no migration defines app_invite_seat_authorized').not.toBeNull();
    expect(seatHelperProblems(def!.body), `in ${def!.file}`).toEqual([]);
  });

  it('the seat helper is not executable by API roles', () => {
    const def = latestDefinition('app_invite_seat_authorized', files);
    expect(def, 'no migration defines app_invite_seat_authorized').not.toBeNull();
    const sql = stripSqlComments(files.find((f) => f.file === def!.file)!.sql);
    expect(sql).toMatch(REVOKE_SEAT_HELPER);
    // Stricter than the latest file: no migration may grant it to an API role.
    const grants = files.filter((f) => GRANT_SEAT_HELPER_TO_API.test(stripSqlComments(f.sql))).map((f) => f.file);
    expect(grants, 'a migration grants app_invite_seat_authorized to anon or authenticated').toEqual([]);
  });

  it.each(['accept_work_identity_invite', 'accept_invite'])('%s', (name) => {
    const def = latestDefinition(name, files);
    expect(def, `no migration defines ${name}`).not.toBeNull();
    expect(acceptProblems(def!.body), `in ${def!.file}`).toEqual([]);
  });
});

describe('the matchers fail on a body that dropped the restore', () => {
  const good = `
create or replace function public.create_invite(p_actor uuid) returns jsonb language plpgsql as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(p_company_id::text, 160));
  v_provisioning_crossing := true;
  if not coalesce(v_actor.status = 'active', false) then raise exception 'not_permitted'; end if;
  v_permitted := ((p_deal_id is null and v_company_type = 'client') or p_deal_id is not null)
    or exists (select 1 from public.app_company_effective_permissions(p_actor, p_company_id) ep
                where ep.permission_key = 'company:invites:send');
  insert into invites (tenant_id, auth_method, provisioning_crossing) values (v_tenant, p_auth_method, v_provisioning_crossing);
end;
$$;`;

  it('accepts a good create_invite body', () => {
    expect(createInviteProblems(good)).toEqual([]);
  });

  it.each([
    ['the can_invite projection', good.replace("exists (select 1 from public.app_company_effective_permissions(p_actor, p_company_id) ep\n                where ep.permission_key = 'company:invites:send')", 'coalesce(v_actor.company_id = p_company_id and v_actor.can_invite, false)')],
    ['the resolver', good.replace('company:invites:send', 'company:other')],
    ['the client branch', good.replace("v_company_type = 'client'", "v_company_type = 'target'")],
    ['the actor-active gate', good.replace(/if not coalesce\(v_actor\.status.*\n/, '')],
    ['the shared lock', good.replace(/perform pg_advisory_xact_lock_shared.*\n/, '')],
    ['the shared lock key', good.replace(', 160', ', 1')],
    ['the recorded crossing', good.replace(', provisioning_crossing)', ')')],
  ])('rejects a create_invite body without %s', (_label, body) => {
    expect(createInviteProblems(body)).not.toEqual([]);
  });

  const helper = `
create or replace function public.app_invite_seat_authorized(p_invite invites) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(p_invite.company_id::text, 160));
  v_seat_ok := coalesce(v_inviter.status = 'active', false)
    and coalesce(p_invite.provisioning_crossing, false);
  v_permitted := (p_invite.deal_id is null and v_company_type = 'client')
    or exists (select 1 from public.app_company_effective_permissions(v_inviter.id, p_invite.company_id) ep
                where ep.permission_key = 'company:invites:send');
end;
$$;`;

  it('accepts a good helper body', () => {
    expect(seatHelperProblems(helper)).toEqual([]);
  });

  it.each([
    ['the can_invite projection', helper.replace('or exists', 'or coalesce(v_inviter.can_invite, false) or exists')],
    ['the inviter-active check', helper.replace("v_inviter.status = 'active'", 'true')],
    ['the shared lock', helper.replace(/perform pg_advisory_xact_lock_shared.*\n/, '')],
    ['the client branch', helper.replace("v_company_type = 'client'", 'false')],
    ['security definer', helper.replace('security definer', 'security invoker')],
    ['the recorded crossing', helper.replace('coalesce(p_invite.provisioning_crossing, false)', 'public.tenant_is_unprovisioned(v_company_tenant)')],
  ])('rejects a helper body without %s', (_label, body) => {
    expect(seatHelperProblems(body)).not.toEqual([]);
  });

  it('accepts an acceptance body that calls the helper and rejects one that does not', () => {
    const accepting = `if not public.app_invite_seat_authorized(v_invite) then raise exception 'inviter_not_authorized'; end if;`;
    expect(acceptProblems(accepting)).toEqual([]);
    expect(acceptProblems('v_permitted := coalesce(v_inviter.can_invite, false);')).not.toEqual([]);
    expect(acceptProblems(accepting.replace('inviter_not_authorized', 'x'))).not.toEqual([]);
  });

  it('finds the latest definition by file order and ignores the _with_affiliation sibling', () => {
    const def = latestDefinition('create_invite', [
      { file: 'a.sql', sql: 'create function create_invite(a int) returns int as $$ select 1 $$;' },
      { file: 'b.sql', sql: 'create function create_invite_with_affiliation(a int) returns int as $$ select 2 $$;' },
    ]);
    expect(def?.file).toBe('a.sql');
    expect(latestDefinition('create_invite', [{ file: 'c.sql', sql: 'select 1;' }])).toBeNull();
  });
});

describe('the text guard reads code, not comments, and any dollar-quote tag', () => {
  const goodBody = `
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(p_company_id::text, 160));
  v_provisioning_crossing := true;
  if not coalesce(v_actor.status = 'active', false) then raise exception 'not_permitted'; end if;
  v_permitted := (p_deal_id is null and v_company_type = 'client')
    or exists (select 1 from public.app_company_effective_permissions(p_actor, p_company_id) ep
                where ep.permission_key = 'company:invites:send');
  insert into invites (tenant_id, provisioning_crossing) values (v_tenant, v_provisioning_crossing);
end;`;
  const define = (tag: string, body: string) =>
    `create or replace function public.create_invite(p_actor uuid) returns jsonb language plpgsql as ${tag}${body}\n${tag};`;
  const bodyOf = (sql: string) => latestDefinition('create_invite', [{ file: 'x.sql', sql }])!.body;

  it('strips line and block comments but keeps string literals', () => {
    expect(stripSqlComments("select 1; -- gone\nselect '--kept', /* gone */ 2")).toBe("select 1; \nselect '--kept',   2");
    expect(stripSqlComments("a /* outer /* inner */ still outer */ b")).toBe('a   b');
    expect(stripSqlComments("select 'it''s -- fine' -- c'")).toBe("select 'it''s -- fine' ");
  });

  it('a commented-out predicate does not satisfy a matcher', () => {
    expect(createInviteProblems(bodyOf(define('$$', goodBody)))).toEqual([]);
    // The whole resolver predicate inside a block comment (newlines kept, so the
    // raw text still matches): only comment stripping makes this fail.
    const resolverCommented = goodBody.replace(/(exists \(select 1 from public\.app_company_effective_permissions[\s\S]*?'company:invites:send'\))/, '/* $1 */');
    expect(resolverCommented).not.toBe(goodBody);
    expect(createInviteProblems(resolverCommented)).toEqual([]);
    expect(createInviteProblems(bodyOf(define('$$', resolverCommented)))).not.toEqual([]);
    const blockCommented = goodBody.replace(
      /(perform pg_advisory_xact_lock_shared[^\n]*)/,
      '/* $1 */',
    );
    expect(createInviteProblems(blockCommented)).toEqual([]);
    expect(createInviteProblems(bodyOf(define('$$', blockCommented)))).not.toEqual([]);
    // A commented-out projection read is not a projection read.
    expect(createInviteProblems(bodyOf(define('$$', `${goodBody}\n-- v_actor.can_invite`)))).toEqual([]);
  });

  it('a commented-out definition is not a definition', () => {
    expect(latestDefinition('create_invite', [{ file: 'x.sql', sql: `-- ${define('$$', goodBody).replace(/\n/g, '\n-- ')}` }])).toBeNull();
  });

  it('parses a $fn$ body and stops at its own delimiter', () => {
    const def = bodyOf(`${define('$fn$', `${goodBody}\n  v_x := '$$ inside $$';`)}\nselect 'after';`);
    expect(createInviteProblems(def)).toEqual([]);
    expect(def.endsWith('$fn$')).toBe(true);
    expect(def).not.toContain('after');
    expect(dollarBody(def)).toContain("v_x := '$$ inside $$';");
    // The same body with its predicate removed still fails under a custom tag.
    expect(createInviteProblems(bodyOf(define('$fn$', goodBody.replace('company:invites:send', 'x'))))).not.toEqual([]);
  });

  it('the API-role grant matcher fires on a grant and on a multi-role grant, not on a revoke or a comment', () => {
    const grant = 'grant execute on function public.app_invite_seat_authorized(public.invites) to authenticated;';
    expect(GRANT_SEAT_HELPER_TO_API.test(grant)).toBe(true);
    expect(GRANT_SEAT_HELPER_TO_API.test(grant.replace('authenticated', 'service_role, anon'))).toBe(true);
    expect(GRANT_SEAT_HELPER_TO_API.test(grant.replace('authenticated', 'service_role'))).toBe(false);
    expect(GRANT_SEAT_HELPER_TO_API.test(stripSqlComments(`-- ${grant}`))).toBe(false);
    expect(GRANT_SEAT_HELPER_TO_API.test('revoke all on function public.app_invite_seat_authorized(invites) from anon;')).toBe(false);
    expect(REVOKE_SEAT_HELPER.test('revoke all on function public.app_invite_seat_authorized(invites) from public, anon, authenticated;')).toBe(true);
    expect(REVOKE_SEAT_HELPER.test(stripSqlComments('-- revoke all on function public.app_invite_seat_authorized(invites) from public, anon, authenticated;'))).toBe(false);
  });
});

describe('the rollback restores the 20261002100000 bodies verbatim and drops the helper', () => {
  const read = (dir: string, prefix: string) => {
    const file = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith('.sql'));
    expect(file, `no ${prefix}* in ${dir}`).toBeTruthy();
    return { file: file!, sql: readFileSync(join(dir, file!), 'utf8') };
  };
  const previous = read(MIGRATIONS, '20261002100000_');
  const rollback = read(join(process.cwd(), 'supabase/rollback'), '20261003100000_');

  it.each(['create_invite', 'accept_work_identity_invite', 'accept_invite'])('%s', (name) => {
    const before = latestDefinition(name, [previous]);
    const after = latestDefinition(name, [rollback]);
    expect(before, `${previous.file} does not define ${name}`).not.toBeNull();
    expect(after, `${rollback.file} does not define ${name}`).not.toBeNull();
    const beforeBody = dollarBody(before!.body);
    const afterBody = dollarBody(after!.body);
    expect(beforeBody).toBeTruthy();
    expect(normalizeSql(afterBody!)).toBe(normalizeSql(beforeBody!));
  });

  it('drops the seat helper', () => {
    expect(stripSqlComments(rollback.sql)).toMatch(
      /drop\s+function\s+(?:if\s+exists\s+)?public\.app_invite_seat_authorized\s*\(\s*(?:public\.)?invites\s*\)/i,
    );
  });
});
