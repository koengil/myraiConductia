// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * G-01 (#173), slice 1: the propose step's information barrier is judged per SOURCE, through
 * discovery_proposal_may_name. supabase/tests/discovery_model_proposals.sql pins the behaviour against a database; this
 * pins the shape in the migrations, so a later restatement (G-02, the team slices) cannot bring back a test that asks
 * who else can see a candidate. The latest definition of each function is the one that counts, so the scan follows
 * `create or replace` across files in order.
 */

type Migration = { file: string; sql: string };

// What a per-source test must never ask: whether some person (the owner, the CCO, a reader) can see the candidate,
// or what the control room or the person-keyed visibility index says.
const OWNER_WIDE = [
  'app_is_firm_cco',
  'app_can_see_candidate',
  'app_can_see_item',
  'app_is_control_room',
  'app_item_cco_allowed_source',
  'candidate_visibility',
] as const;

function readMigrations(): Migration[] {
  const dir = join(process.cwd(), 'supabase/migrations');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') }));
}

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');

/** The latest `create [or replace] function <name>(...)` through the end of its dollar-quoted body, comments removed. */
export function latestDefinition(migrations: Migration[], name: string): string | undefined {
  const start = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${name}\\s*\\(`, 'gi');
  let found: string | undefined;
  for (const { sql: raw } of [...migrations].sort((a, b) => a.file.localeCompare(b.file))) {
    const sql = stripComments(raw);
    for (const m of sql.matchAll(start)) {
      const at = m.index ?? 0;
      const open = /\$[a-z_]*\$/i.exec(sql.slice(at + m[0].length));
      if (!open) continue;
      const bodyStart = at + m[0].length + (open.index ?? 0);
      const end = sql.indexOf(open[0], bodyStart + open[0].length);
      found = sql.slice(at, end < 0 ? undefined : end + open[0].length);
    }
  }
  return found;
}

const namesOwnerWide = (body: string) => OWNER_WIDE.filter((name) => new RegExp(`\\b${name}\\b`).test(body));

describe('the propose step names deals per source (G-01 #173)', () => {
  const migrations = readMigrations();
  const mayName = latestDefinition(migrations, 'discovery_proposal_may_name');
  const knownDeals = latestDefinition(migrations, 'discovery_proposal_known_deals');
  const writer = latestDefinition(migrations, 'discovery_record_model_proposal');

  it('defines the barrier test, the known-deals read and the writer', () => {
    expect(mayName, 'discovery_proposal_may_name').toBeDefined();
    expect(knownDeals, 'discovery_proposal_known_deals').toBeDefined();
    expect(writer, 'discovery_record_model_proposal').toBeDefined();
  });

  it('keeps the barrier test free of any owner-wide visibility test, the CCO path included', () => {
    expect(namesOwnerWide(mayName ?? '')).toEqual([]);
  });

  it('reads the barrier test from this source only: its own provenance and its own readability', () => {
    expect(mayName).toMatch(/content_source_id\s*=\s*p_source/i);
    expect(mayName).toMatch(/allowed_team_mailboxes/i);
    expect(mayName).toMatch(/allowed_mailboxes/i);
    expect(mayName).toMatch(/l\.state\s*<>\s*'rejected'/i);
    expect(mayName).toMatch(/l\.route_tier\s*=\s*'firm'\s+or\s+l\.state\s*=\s*'confirmed'/i);
  });

  it('builds the known-deals list on the barrier test, not on who can see a candidate', () => {
    expect(knownDeals).toMatch(/discovery_proposal_may_name\s*\(/i);
    expect(namesOwnerWide(knownDeals ?? '')).toEqual([]);
    // The model-named deals come from this source's rows, never every source of its owner.
    expect(knownDeals).toMatch(/join\s+src\s+on\s+src\.id\s*=\s*p\.content_source_id/i);
  });

  it('puts to the barrier test only the candidates linked to this source\'s own items (review F2)', () => {
    // A pre-filter on the source's provenance, so may_name runs per linked candidate, not per live candidate.
    expect(knownDeals).toMatch(/source_item_sources\s+s\s+on\s+s\.content_source_id\s*=\s*src\.id/i);
    expect(knownDeals).toMatch(/join\s+deal_candidates\s+dc\s+on\s+dc\.id\s*=\s*linked\.candidate_id/i);
  });

  it('judges the writer\'s candidate by the barrier test and refuses a source nobody reads', () => {
    expect(writer).toMatch(/discovery_proposal_may_name\s*\(/i);
    expect(writer).toMatch(/source has no reader/i);
    expect(namesOwnerWide(writer ?? '')).toEqual([]);
  });

  it('refuses a team source in the writer unless it is admitted (ADR-0026 residual 4, review F1)', () => {
    // Slice 1 refuses every team source; slice 4 admits one only with a live approval and an open pass. Either way the
    // writer names team_not_approved with 42501, so no slice lets a team row in on its own.
    expect(writer).toMatch(/if\s+v_team\s+is\s+not\s+null\s+then/i);
    expect(writer).toMatch(/raise\s+exception\s+'team_not_approved'\s+using\s+errcode\s*=\s*'42501'/i);
  });

  it('admits a team row only under a live approval and an open pass with a live lease (slice 4, review F6)', () => {
    expect(writer).toMatch(/app_tenant_capability_on\s*\(\s*p_tenant_id\s*,\s*v_firm\s*,\s*'team_proposals'\s*\)/i);
    const passCheck = /from\s+discovery_team_proposal_passes\s+ps\s+where([\s\S]*?)for\s+share/i.exec(writer ?? '')?.[1] ?? '';
    expect(passCheck).toMatch(/ps\.run_id\s*=\s*v_run/i);
    expect(passCheck).toMatch(/ps\.closed_at\s+is\s+null/i);
    expect(passCheck).toMatch(/ps\.lease_until\s*>\s*now\(\)/i);
  });

  it('pins every definer to public, pg_temp', () => {
    for (const [name, body] of [
      ['discovery_proposal_may_name', mayName],
      ['discovery_proposal_known_deals', knownDeals],
      ['discovery_record_model_proposal', writer],
    ] as const) {
      expect(body, name).toMatch(/security\s+definer/i);
      expect(body, name).toMatch(/set\s+search_path\s*=\s*public\s*,\s*pg_temp/i);
    }
  });

  it('would catch a later restatement that asks who can see the candidate', () => {
    const later: Migration[] = [
      ...migrations,
      {
        file: '99999999999999_regress.sql',
        sql: `create or replace function discovery_proposal_may_name(p_source uuid, p_candidate uuid)
              returns boolean language sql security definer set search_path = public, pg_temp as $$
                select app_can_see_candidate(p_candidate, (select owner_user_id from content_sources where id = p_source));
              $$;`,
      },
    ];
    expect(namesOwnerWide(latestDefinition(later, 'discovery_proposal_may_name') ?? '')).toEqual(['app_can_see_candidate']);
  });

  it('ignores a comment that only names the old test', () => {
    const body = latestDefinition(
      [
        {
          file: '1.sql',
          sql: `create function discovery_proposal_may_name(p_source uuid, p_candidate uuid)
                returns boolean language sql as $$
                  -- never app_can_see_candidate or app_is_firm_cco
                  select false;
                $$;`,
        },
      ],
      'discovery_proposal_may_name',
    );
    expect(namesOwnerWide(body ?? '')).toEqual([]);
  });
});
