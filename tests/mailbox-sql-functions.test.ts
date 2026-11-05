// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MAILBOX_DERIVED_TABLES } from '@/lib/constants/discovery';

import classified from './fixtures/mailboxSqlFunctions.json';

/**
 * A function that reads mailbox-derived tables behind an RPC name is invisible
 * to the TypeScript analysis in tests/agent-surfaces.test.ts, so SQL gets its
 * own classification (#262, R14, R21). Every migration function whose header
 * or body names a mailbox-derived table or view must be listed in
 * tests/fixtures/mailboxSqlFunctions.json with the guard or helper that covers
 * it. An unlisted one fails, and so does a listed name that no longer exists.
 * The list is also what tests/agent-surfaces.test.ts builds its RPC detector
 * from, so an RPC that reads mail cannot be called outside the accessors.
 */

type Migration = { file: string; sql: string };
type Classified = { name: string; reason: string };

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');
const DERIVED = new RegExp(`\\b(?:${MAILBOX_DERIVED_TABLES.join('|')})\\b`);
const DEFINITION = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
const DROP = /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** The last definition of each function across the migrations, minus dropped ones. */
export function functionDefinitions(migrations: Migration[]): Map<string, string> {
  const defs = new Map<string, string>();
  for (const { sql: raw } of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
    const sql = stripComments(raw);
    const events: Array<{ at: number; run: () => void }> = [];
    for (const m of sql.matchAll(DEFINITION)) {
      const start = m.index ?? 0;
      const tagAt = sql.indexOf('$', start + m[0].length);
      const tag = tagAt < 0 ? null : /^\$[a-z_]*\$/i.exec(sql.slice(tagAt))?.[0];
      let text = sql.slice(start);
      if (tag) {
        const end = sql.indexOf(tag, tagAt + tag.length);
        text = sql.slice(start, end < 0 ? undefined : end + tag.length);
      }
      events.push({ at: start, run: () => defs.set(m[1].toLowerCase(), text) });
    }
    for (const m of sql.matchAll(DROP)) events.push({ at: m.index ?? 0, run: () => defs.delete(m[1].toLowerCase()) });
    events.sort((a, b) => a.at - b.at).forEach((event) => event.run());
  }
  return defs;
}

/**
 * The function names whose header or body names a mailbox-derived table or
 * view, or calls such a function (so a thin wrapper such as
 * mailbox_items_visible_to is classified with the helper it delegates to).
 */
export function mailboxFunctionsIn(migrations: Migration[]): string[] {
  const defs = functionDefinitions(migrations);
  const found = new Set([...defs].filter(([, text]) => DERIVED.test(text)).map(([name]) => name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, text] of defs) {
      if (found.has(name)) continue;
      if ([...found].some((callee) => new RegExp(`\\b${callee}\\s*\\(`).test(text))) {
        found.add(name);
        grew = true;
      }
    }
  }
  return [...found].sort();
}

function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }));
}

const listed = classified as Classified[];

describe('every SQL function that reads mailbox-derived tables is classified (#262)', () => {
  const found = mailboxFunctionsIn(readMigrations());

  it('lists every migration function that names a mailbox-derived table', () => {
    const unlisted = found.filter((name) => !listed.some((entry) => entry.name === name));
    expect(unlisted, 'add each to tests/fixtures/mailboxSqlFunctions.json with the guard or helper that covers it').toEqual([]);
  });

  it('lists no function that no longer exists or no longer reads mailbox tables', () => {
    expect(listed.map((entry) => entry.name).filter((name) => !found.includes(name))).toEqual([]);
  });

  it('does not classify the service-only deal contact lookup as a mailbox-content RPC', () => {
    expect(functionDefinitions(readMigrations()).has('send_census_deal_contacts')).toBe(true);
    expect(found).not.toContain('send_census_deal_contacts');
    expect(listed.map((entry) => entry.name)).not.toContain('send_census_deal_contacts');
  });

  it('gives every entry a reason, sorted and unique', () => {
    for (const entry of listed) expect(entry.reason.length, entry.name).toBeGreaterThan(20);
    const names = listed.map((entry) => entry.name);
    expect(names).toEqual([...new Set(names)].sort());
  });

  it('flags a new function that reads source_items behind an RPC name', () => {
    const migrations: Migration[] = [
      ...readMigrations(),
      {
        file: '99999999999999_search_mail.sql',
        sql: `create or replace function search_mail() returns setof uuid language sql security definer as $$
                select id from source_items;
              $$;`,
      },
    ];
    expect(mailboxFunctionsIn(migrations)).toContain('search_mail');
  });

  it('flags a wrapper that only calls a classified function', () => {
    const migrations: Migration[] = [
      ...readMigrations(),
      {
        file: '99999999999999_wrapper.sql',
        sql: 'create function see_item(p uuid) returns boolean language sql as $$ select app_can_see_item(p, null); $$;',
      },
    ];
    expect(mailboxFunctionsIn(migrations)).toContain('see_item');
  });

  it('follows a later redefinition and a later drop', () => {
    const base = 'create function reads_mail() returns int language sql as $$ select count(*)::int from source_items; $$;';
    expect(mailboxFunctionsIn([{ file: '1.sql', sql: base }])).toEqual(['reads_mail']);
    const clean = 'create or replace function reads_mail() returns int language sql as $$ select 1; $$;';
    expect(mailboxFunctionsIn([{ file: '1.sql', sql: base }, { file: '2.sql', sql: clean }])).toEqual([]);
    expect(mailboxFunctionsIn([{ file: '1.sql', sql: base }, { file: '2.sql', sql: 'drop function if exists reads_mail();' }])).toEqual([]);
  });
});
