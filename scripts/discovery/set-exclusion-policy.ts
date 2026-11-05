/**
 * Writes a new version of a tenant's mailbox exclusion policy (#263).
 *
 *   node --env-file=.env.<target> --import tsx scripts/discovery/set-exclusion-policy.ts \
 *     --tenant <tenant uuid> --requested-by "<who at the bank asked>" \
 *     --expected-version <current version, 0 for none> --rules <rules.json> [--confirm]
 *
 * The rules file is a JSON list of rules (an empty list `[]` is a valid, deliberate
 * policy: a live tenant needs one audited write before any mailbox is read). Without
 * --confirm the script prints the diff against the current version and writes
 * nothing. With --confirm it calls discovery_exclusion_policy_set, the only writer,
 * which takes the version, refuses a stale one, and writes the chained
 * discovery.exclusion_policy_changed audit row in the same transaction.
 *
 * `--print-template` prints the recommended starting rules and exits: save the output, replace the counsel
 * domain placeholder with the bank's outside counsel, and pass the file as --rules. It is never applied by
 * itself, because which markers, labels and counsel domains a bank excludes is the bank's call.
 *
 * Operator-only: it uses the service role from the environment, run by hand, never
 * from a request, the worker or an agent. It prints rule ids, kinds and the values the
 * operator typed (domains, addresses, markers: the bank's configuration), never mail.
 * Who at the bank owns this list is the owner's call (thread T6); until a session RPC
 * and an editor exist, Conductia staff make a change at the bank's written request, and
 * --requested-by names that requester. The audit row is a service row (actor "service"), so
 * this free text is the only record of who asked: give a real person or ticket ("Jordan
 * Ames, CCO, ticket SEC-142"), never the operator's own name alone. An empty value is refused.
 */
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { GMAIL_CLASSIFICATION_FIELD_VERIFIED } from '../../src/lib/constants/googleReader';
import { TABLE } from '../../src/lib/constants/tables';
import { diffRules, validateRules, type RuleDiff } from '../../src/lib/discovery/exclusion/validate';
import type { PolicyRule } from '../../src/lib/discovery/exclusion/types';

/**
 * The recommended starting policy (design R11), never applied automatically. Privilege attaches to the conversation, so
 * the sensitivity markers and the Privileged, Confidential and HR labels are thread rules: a reply that quotes the
 * advice is excluded with it. Outside counsel is copied on most M&A threads, so a thread rule on counsel's domain
 * would blind discovery on exactly the deals that matter: that rule is message-scoped. The domain is a placeholder.
 */
export const RECOMMENDED_TEMPLATE: readonly Record<string, unknown>[] = [
  { id: 'marker-private', category: 'confidential', scope: 'thread', kind: 'header_marker', header: 'sensitivity', contains: 'Private' },
  { id: 'marker-personal', category: 'hr', scope: 'thread', kind: 'header_marker', header: 'sensitivity', contains: 'Personal' },
  { id: 'marker-company-confidential', category: 'confidential', scope: 'thread', kind: 'header_marker', header: 'sensitivity', contains: 'Company-Confidential' },
  { id: 'label-privileged', category: 'privileged', scope: 'thread', kind: 'label', names: ['Privileged'] },
  { id: 'label-confidential', category: 'confidential', scope: 'thread', kind: 'label', names: ['Confidential'] },
  { id: 'label-hr', category: 'hr', scope: 'thread', kind: 'label', names: ['HR'] },
  // Replace with the bank's outside counsel before writing the version.
  { id: 'outside-counsel', category: 'privileged', scope: 'message', kind: 'participant_domain', domains: ['outside-counsel.example'] },
];

export type Args = { tenant: string; requestedBy: string; expectedVersion: number; rulesFile: string; confirm: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueOf(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function parseArgs(argv: string[]): Args {
  const tenant = valueOf(argv, '--tenant')?.trim();
  const requestedBy = valueOf(argv, '--requested-by')?.trim();
  const expected = valueOf(argv, '--expected-version')?.trim();
  const rulesFile = valueOf(argv, '--rules')?.trim();
  if (!tenant || !UUID.test(tenant)) throw new Error('--tenant <tenant uuid> is required');
  if (!requestedBy) throw new Error('--requested-by "<who at the bank asked>" is required');
  if (expected === undefined || !/^\d+$/.test(expected)) throw new Error('--expected-version <n> is required (0 when the tenant has no policy yet)');
  if (!rulesFile) throw new Error('--rules <file.json> is required (a JSON list; [] is an explicit empty policy)');
  return { tenant, requestedBy, expectedVersion: Number(expected), rulesFile, confirm: argv.includes('--confirm') };
}

const describeRule = (rule: PolicyRule): string => {
  const what =
    rule.kind === 'participant_domain'
      ? rule.domains.join(', ')
      : rule.kind === 'participant_address'
        ? rule.addresses.join(', ')
        : rule.kind === 'header_marker'
          ? `${rule.header} contains "${rule.contains}"`
          : rule.kind === 'label'
            ? rule.names.join(', ')
            : `classification ${rule.labelId}${rule.fieldId ? ` / ${rule.fieldId}` : ''}${rule.selectionId ? ` = ${rule.selectionId}` : ''}`;
  return `${rule.id} [${rule.kind}, ${rule.category}, ${rule.scope}] ${what}`;
};

export function renderDiff(diff: RuleDiff, from: number, requestedBy: string): string[] {
  const lines = [`Version ${from} -> ${from + 1}, requested by ${requestedBy}`];
  for (const rule of diff.added) lines.push(`  + ${describeRule(rule)}`);
  for (const rule of diff.removed) lines.push(`  - ${describeRule(rule)}`);
  for (const { before, after } of diff.modified) {
    lines.push(`  ~ ${after.id}: scope ${before.scope} -> ${after.scope}, category ${before.category} -> ${after.category}`);
  }
  if (diff.unchanged > 0) lines.push(`  = ${diff.unchanged} rule(s) unchanged`);
  if (diff.added.length + diff.removed.length + diff.modified.length === 0) lines.push('  (no change to the rules; the new version still records the requester)');
  return lines;
}

type VersionRow = { version: number; rules: unknown };

/** The tenant's versions, newest first. */
async function versionsOf(db: SupabaseClient, tenant: string): Promise<VersionRow[]> {
  const { data, error } = await db
    .from(TABLE.DISCOVERY_EXCLUSION_POLICIES)
    .select('version, rules')
    .eq('tenant_id', tenant)
    .order('version', { ascending: false });
  if (error) throw new Error(`exclusion policy read failed: ${error.message}`);
  return (data ?? []) as VersionRow[];
}

/** Rules of a stored version as typed rules where they validate, else as stored (an earlier build accepted more kinds). */
const rulesIn = (row: VersionRow | undefined): PolicyRule[] => (Array.isArray(row?.rules) ? (row.rules as PolicyRule[]) : []);

/**
 * Until a live read shows Gmail returns classificationLabelValues (thread T1), a classification rule cannot be
 * evaluated: every message it meets is excluded as unevaluable. Said before the write, never refused: failing closed
 * is the safe direction, but the operator should know the rule will exclude all mail until then.
 */
export function classificationWarnings(rules: readonly PolicyRule[], verified = GMAIL_CLASSIFICATION_FIELD_VERIFIED): string[] {
  if (verified) return [];
  return rules
    .filter((rule) => rule.kind === 'classification')
    .map(
      (rule) =>
        `warning: rule ${rule.id} is a classification rule, and the Gmail classification field is not verified yet ` +
        '(GMAIL_CLASSIFICATION_FIELD_VERIFIED). Every message it meets will be excluded as unevaluable until it is.',
    );
}

export async function run(argv: string[], db?: SupabaseClient, log: (line: string) => void = console.log): Promise<number> {
  if (argv.includes('--print-template')) {
    log(JSON.stringify(RECOMMENDED_TEMPLATE, null, 2));
    return 0;
  }
  const args = parseArgs(argv);
  const parsed = validateRules(JSON.parse(readFileSync(args.rulesFile, 'utf8')) as unknown);
  if (!parsed.ok) {
    for (const error of parsed.errors) log(`invalid: ${error}`);
    return 1;
  }

  let client = db;
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SECRET_KEY?.trim();
    if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
    log(`Target: supabase ${new URL(url).hostname.split('.')[0]}, tenant ${args.tenant}`);
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  const versions = await versionsOf(client, args.tenant);
  const current = versions[0]?.version ?? 0;
  if (current !== args.expectedVersion) {
    log(`stale: the tenant's current version is ${current}, not ${args.expectedVersion}. Re-read the diff and run again.`);
    return 1;
  }
  const earlier = versions.flatMap((row) => rulesIn(row));
  const diff = diffRules(rulesIn(versions[0]), parsed.rules, earlier);
  if (diff.conditionChanged.length > 0) {
    for (const { id } of diff.conditionChanged) log(`refused: rule ${id} changes its condition. A rule id names one condition forever: give it a new id.`);
    return 1;
  }
  for (const line of renderDiff(diff, current, args.requestedBy)) log(line);
  for (const line of classificationWarnings(parsed.rules)) log(line);

  if (!args.confirm) {
    log('Dry run: nothing written. Add --confirm to write this version.');
    return 0;
  }
  const { data, error } = await client.rpc('discovery_exclusion_policy_set', {
    p_tenant_id: args.tenant,
    p_rules: parsed.rules,
    p_expected_version: args.expectedVersion,
    p_requested_by: args.requestedBy,
  });
  if (error) {
    log(`refused: ${error.message}`);
    return 1;
  }
  log(`Wrote version ${String(data)}.`);
  return 0;
}

if (process.argv[1]?.endsWith('set-exclusion-policy.ts')) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
