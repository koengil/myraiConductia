import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  DISCOVERY_AUDIT_ACTIONS,
} from '../src/lib/constants/audit';
import { DEAL_STATUSES, SCHEDULE_STATUSES, LIFECYCLE_CATEGORIES } from '../src/lib/constants/deals';
import { BENCH_RUN_STATUSES, STEP_STATUSES } from '../src/lib/constants/dealSteps';
import { NOTIFICATION_EVENTS } from '../src/lib/constants/notifications';
import { DOCUMENT_ROOM } from '../src/lib/constants/documents';
import {
  DISCOVERY_STATES,
  DELEGATION_STATUSES,
  GOOGLE_REGISTRATION_STATUSES,
  LINK_STATES,
  MAILBOX_PROVIDERS,
  ROUTE_METHODS,
  ROUTE_TIERS,
  ROUTING_DECISIONS,
  SKIP_REASONS,
  SOURCE_ITEM_KINDS,
  SOURCE_KINDS,
} from '../src/lib/constants/discovery';
import {
  hostOf,
  missingFrom,
  readSchemaCatalog,
  readSnapshot,
  resolveDatabaseUrl,
  runPsql,
} from './lib/schemaCatalog';

/*
 * Migration-drift preflight. `npm run db:migrate` replays files with psql and
 * keeps no ledger, so a database built from a partial dump or a stale branch
 * looks healthy until a write hits a CHECK the code outgrew. That is how the
 * Book started answering 500 on a fresh database: the audit enum predated
 * 'update', the deal row saved, and the audit insert failed behind it.
 *
 * So this asks the database what it can actually accept, rather than which
 * files someone believes they ran. It checks two things, neither remembered by
 * hand:
 *
 *   - every table, view, column, function and policy in supabase/schema-snapshot.txt
 *     exists. CI regenerates that file from the migrations on every PR, so a
 *     new migration is covered the moment it merges;
 *   - every CHECK enum accepts the values in src/lib/constants/*, the same
 *     constants the application writes with. A list of names cannot see those.
 *
 * Run it against PROD before go-live:
 *
 *   npm run preflight:db                    # .env.local
 *   npm run preflight:db .env.production    # the go-live target
 *
 * The Migrate database workflow runs it after it applies migrations. Every read
 * goes through pg_catalog (scripts/lib/schemaCatalog.ts), never
 * information_schema, so it also works as a role with no grants, and a psql
 * failure names the host, never the URL.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');

type EnumCheck = {
  table: string;
  column: string;
  expected: readonly string[];
};

/** CHECK enums the application writes into. The constants are the mirror. */
const ENUM_CHECKS: EnumCheck[] = [
  { table: 'audit_log', column: 'action', expected: [...AUDIT_ACTIONS, ...DISCOVERY_AUDIT_ACTIONS] },
  { table: 'audit_log', column: 'actor_type', expected: AUDIT_ACTOR_TYPES },
  { table: 'notifications', column: 'event_type', expected: NOTIFICATION_EVENTS },
  { table: 'deals', column: 'status', expected: DEAL_STATUSES },
  { table: 'deals', column: 'schedule_status', expected: SCHEDULE_STATUSES },
  { table: 'deals', column: 'lifecycle_category', expected: LIFECYCLE_CATEGORIES },
  { table: 'deal_steps', column: 'status', expected: STEP_STATUSES },
  { table: 'deal_steps', column: 'bench_run_status', expected: BENCH_RUN_STATUSES },
  { table: 'documents', column: 'room', expected: Object.values(DOCUMENT_ROOM) },
  // Deal discovery: the values the classification worker writes.
  { table: 'deal_candidates', column: 'discovery_state', expected: DISCOVERY_STATES },
  { table: 'evidence_links', column: 'route_tier', expected: ROUTE_TIERS },
  { table: 'evidence_links', column: 'state', expected: LINK_STATES },
  { table: 'evidence_links', column: 'method', expected: ROUTE_METHODS },
  { table: 'routing_ledger', column: 'decision', expected: ROUTING_DECISIONS },
  { table: 'routing_ledger', column: 'skip_reason', expected: SKIP_REASONS },
  { table: 'content_sources', column: 'kind', expected: SOURCE_KINDS },
  { table: 'content_sources', column: 'provider', expected: MAILBOX_PROVIDERS },
  { table: 'google_reader_registrations', column: 'status', expected: GOOGLE_REGISTRATION_STATUSES },
  { table: 'google_reader_registrations', column: 'delegation_status', expected: DELEGATION_STATUSES },
  { table: 'source_items', column: 'kind', expected: SOURCE_ITEM_KINDS },
];

/**
 * The deal-discovery security definer functions `authenticated` executes,
 * keyed as `schema.proname(identity args)`. The definer-grant gate is
 * 20260929170000_close_definer_function_grants.sql with its probe
 * supabase/tests/definer_grants.sql; the health view is re-granted after it
 * by 20260929180000_discovery_health_grant.sql. Each entry reads auth.uid()
 * and answers only about the caller (or for service_role), and
 * supabase/tests/discovery_health.sql pins all eighteen.
 */
export const DISCOVERY_AUTHENTICATED_DEFINERS: readonly string[] = [
  // RLS helpers of 20260925120000_discovery_core (phase 3).
  'public.app_is_control_room(p_user uuid)',
  'public.app_owns_item(p_item uuid, p_user uuid)',
  'public.app_can_see_candidate(p_candidate uuid, p_user uuid)',
  'public.app_can_see_item(p_item uuid, p_user uuid)',
  // The admin and control room's health view, 20260925150000_discovery_health (phase 4).
  'public.discovery_ingestion_health()',
  // The firm admin's and CCO's allowlist drift and site registrations (#262).
  'public.discovery_allowlist_health()',
  'public.discovery_site_registrations()',
  // The firm admin's merge of an archived mailbox source into the live one (#262, round 3).
  'public.discovery_unify_mailbox_sources(p_archived uuid, p_target uuid)',
  // The banker's corrections (20261002210000_discovery_corrections): each acts on
  // auth.uid() and checks tenant, visibility and deal-create authority itself.
  'public.discovery_rename_candidate(p_candidate uuid, p_name text, p_reason text)',
  'public.discovery_reject_candidate(p_candidate uuid, p_reason text)',
  'public.discovery_set_station(p_candidate uuid, p_step_id text, p_reason text)',
  'public.discovery_merge_candidates(p_merged uuid, p_survivor uuid, p_reason text)',
  'public.discovery_correction_authority(p_candidate uuid, p_action text)',
  // Split and reassign (20261002230000_discovery_split_reassign): the same contract.
  'public.discovery_split_candidate(p_candidate uuid, p_source_item_ids uuid[], p_name text, p_reason text)',
  'public.discovery_reassign_link(p_link uuid, p_target_candidate uuid, p_reason text)',
  // The MD dismisses the rail's evidence marker on their own session
  // (20261002220000_discovery_promotion). discovery_promote_candidate is service_role only, so it is not here.
  'public.discovery_dismiss_suggestion(p_deal_id uuid, p_assessment_id uuid, p_reason text)',
  // A Gmail member's own source status, and a firm admin's pause and resume of a Google source (#259, phase 4).
  'public.discovery_google_mailbox_status()',
  'public.discovery_set_mailbox_source_status(p_source_id uuid, p_status text)',
  // Reader liveness (20261008210000_discovery_restart_source): a firm admin restarts a halted mailbox source.
  'public.discovery_restart_mailbox_source(p_source_id uuid)',
  // Ingestion window (20261018110000_discovery_set_source_window, #353): a firm admin sets a Gmail mailbox's window.
  'public.discovery_set_mailbox_source_window(p_source_id uuid, p_since date)',
  // The owner's read of an item's walled subject and participants (20261017100000_source_items_column_wall).
  'public.discovery_item_metadata(p_items uuid[])',
  // The current-events read (20261023130400, #173 G-07): which of the caller's visible items' events are current.
  'public.discovery_item_current_events(p_item_ids uuid[])',
  // The team-access read (20261023130500, #173 G-07): which of the caller's visible items they read only through a team inbox.
  'public.discovery_item_team_access(p_item_ids uuid[])',
  // The source owner dismisses a model proposal on their own session (20261023120100_model_proposal_dismissals,
  // G-02a #173). Its read helper and the operator restore are service_role only, so they are not here.
  'public.discovery_dismiss_model_proposal(p_deal_key text)',
  // The source owner asks to accept a model-only proposal on their own session (20261023140100_model_proposal_accepts,
  // G-02b #173). The worker's claim, storing, finish and expiry definers (slice 1b) are service_role only.
  'public.discovery_accept_model_proposal(p_deal_key text, p_proposed_step_id text)',
  // Where a candidate or a deal came from, read past RLS so a deal member or overseer who is not the finder still gets
  // the model-origin pop-up (20261023140400_discovery_origin_read, G-02b #173). Each acts on auth.uid() only.
  'public.discovery_candidate_origins(p_candidate_ids uuid[])',
  'public.discovery_deal_origin(p_deal_id uuid)',
];

/**
 * Which migration files match a predicate. Scanned rather than hardcoded so
 * the advice cannot rot as migrations are added.
 */
function migrationsWhere(match: (sql: string) => boolean): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => match(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
}

/**
 * The migration that introduces a snapshot object: the first one to name it
 * (and, for a column or policy, its table too).
 */
function adviseForName(line: string): string {
  const object = line.slice(line.indexOf(' ') + 1);
  const dot = object.indexOf('.');
  const names = dot === -1 ? [object] : [object.slice(dot + 1), object.slice(0, dot)];
  const files = migrationsWhere((sql) => names.every((name) => sql.includes(name)));
  return files.length === 0 ? 'no migration in this repo defines it' : `apply ${files[0]}`;
}

/** Does this migration define the CHECK enum constraining `table.column`? */
function definesConstraint(sql: string, table: string, column: string): boolean {
  // Both spellings appear in the chain: a named constraint
  // (`deal_steps_bench_run_status_check`) and an inline `check (status in (...))`.
  return sql.includes(`${table}_${column}_check`) || sql.includes(`check (${column} in`);
}

/** The migration that first constrains a column, when the DB has no CHECK at all. */
function adviseForConstraint(table: string, column: string): string {
  const files = migrationsWhere((sql) => definesConstraint(sql, table, column));
  return files.length === 0 ? 'no migration in this repo defines it' : `apply ${files[0]}`;
}

/**
 * The migration that widens a CHECK enum to accept a value: the LAST file that
 * both redefines this column's constraint and names the value. Each widening
 * restates the whole list, so the newest one is the authoritative definition —
 * and skipping it is what silently narrows a live database.
 */
function adviseForEnumValue(table: string, column: string, value: string): string {
  const files = migrationsWhere(
    (sql) => sql.includes(`'${value}'`) && definesConstraint(sql, table, column),
  );
  return files.length === 0
    ? 'no migration in this repo defines it'
    : `apply ${files[files.length - 1]}`;
}

function main(): void {
  const envFile = process.argv[2] ?? '.env.local';
  const databaseUrl = resolveDatabaseUrl(envFile);
  const host = hostOf(databaseUrl);
  console.log(`Preflight target: ${host} (from ${envFile})\n`);

  const problems: string[] = [];
  const snapshot = readSnapshot();
  const catalog = readSchemaCatalog(databaseUrl);
  const presentTables = new Set(
    catalog.filter((line) => line.startsWith('table ')).map((line) => line.slice('table '.length)),
  );

  // 1. Every object the migrations create, per the committed snapshot.
  const missingObjects = missingFrom(snapshot, catalog);
  const kinds = [
    ['table', 'tables'],
    ['view', 'views'],
    ['column', 'columns'],
    ['function', 'functions'],
    ['policy', 'policies'],
  ] as const;
  for (const [kind, label] of kinds) {
    const want = snapshot.filter((line) => line.startsWith(`${kind} `)).length;
    const lacking = missingObjects.filter((line) => line.startsWith(`${kind} `)).length;
    console.log(
      lacking === 0
        ? `✅ ${label} — all ${want} in the schema snapshot present`
        : `❌ ${label} — ${lacking} of ${want} missing`,
    );
  }
  for (const line of missingObjects) problems.push(`${line} is missing — ${adviseForName(line)}`);

  // 2. CHECK enums. The failure this whole script exists for: a constraint
  //    narrower than the values the code writes.
  const constraintRows = runPsql(
    databaseUrl,
    `select conrelid::regclass::text, pg_get_constraintdef(oid)
       from pg_constraint
      where contype = 'c'
        and connamespace = 'public'::regnamespace`,
  );
  const defsByTable = new Map<string, string>();
  for (const [table, def] of constraintRows) {
    defsByTable.set(table, `${defsByTable.get(table) ?? ''}\n${def}`);
  }

  for (const { table, column, expected } of ENUM_CHECKS) {
    if (!presentTables.has(table)) continue;
    const defs = defsByTable.get(table) ?? '';
    // Only consider constraints that actually constrain this column.
    const relevant = defs
      .split('\n')
      .filter((d) => d.includes(column))
      .join('\n');
    if (relevant.trim() === '') {
      problems.push(`${table}.${column} has no CHECK enum — ${adviseForConstraint(table, column)}`);
      console.log(`❌ ${table}.${column} — no CHECK constraint found`);
      continue;
    }
    const missing = expected.filter((v) => !relevant.includes(`'${v}'`));
    if (missing.length === 0) {
      console.log(`✅ ${table}.${column} — accepts all ${expected.length} values`);
      continue;
    }
    console.log(`❌ ${table}.${column} — rejects ${missing.map((m) => `'${m}'`).join(', ')}`);
    for (const v of missing) {
      problems.push(`${table}.${column} rejects '${v}' — ${adviseForEnumValue(table, column, v)}`);
    }
  }

  console.log('');
  if (problems.length === 0) {
    console.log(`✅ ${host} matches what this build writes. Clear for go-live.`);
    return;
  }

  console.log(`❌ ${host} has ${problems.length} drift problem(s):\n`);
  for (const p of problems) console.log(`   - ${p}`);
  console.log(
    '\nA hosted database is migrated only by the Migrate database workflow\n' +
      '(.github/workflows/migrate.yml), which applies the files its ledger does not hold.\n' +
      'Do not apply the files named above by hand: a hand-applied file is not in the ledger\n' +
      'and would be applied again. If this ran inside that workflow, the build expects\n' +
      'something no migration creates: fix it forward on develop. On a local stack, run\n' +
      'supabase db reset --local. Then run this preflight again.',
  );
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('preflight-db.ts')) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
