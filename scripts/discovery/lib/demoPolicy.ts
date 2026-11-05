// The demo Gmail replay's stored exclusion policy (cdt-261-demo-gmail D4). The replay loads a stored policy the
// way live Gmail must (#263, PR #338): a version >= 1 written by discovery_exclusion_policy_set, the only writer,
// which audits it as discovery.exclusion_policy_changed. Idempotent: a re-seed whose rules equal the current
// version's writes nothing and audits nothing. Guarded first: policy rows are append-only, so it refuses a
// non-loopback Supabase URL and a latest version it did not write, before any read or write. Apart from
// scripts/seed-discovery.ts so a test can load it without claiming the reader capability.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '../../../src/lib/constants/tables';
import type { PolicyRule } from '../../../src/lib/discovery/exclusion/types';
import { validateRules } from '../../../src/lib/discovery/exclusion/validate';

import type { CorpusSelection } from './corpusSelect';
import { DEMO_POLICY_REQUESTED_BY } from './demoPolicyRequester';

export { DEMO_POLICY_REQUESTED_BY };

/**
 * The committed rules file, resolved from this module rather than the working directory: the seed may run from
 * anywhere. Resolved on call, not at import, so a non-node test environment can still import this module.
 */
export function demoExclusionPolicyFile(): string {
  return fileURLToPath(new URL('../../../tests/fixtures/discovery/demo/exclusion-policy.json', import.meta.url));
}

export function readDemoPolicyRules(path: string = demoExclusionPolicyFile()): PolicyRule[] {
  const parsed = validateRules(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!parsed.ok) throw new Error(`${path}: ${parsed.errors.join('; ')}`);
  return parsed.rules;
}

/** JSON with sorted keys and no undefined members: jsonb reorders keys, so stored and file rules compare by this. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

/**
 * A policy row can never be removed (append-only), so the demo writes one only into a local stack. The seed itself
 * refuses only NEXT_PUBLIC_APP_ENV=prod; this refuses any Supabase URL that is not loopback, before any request.
 */
export function assertLoopbackSupabase(env: Record<string, string | undefined> = process.env): void {
  if (!env.NEXT_PUBLIC_SUPABASE_URL?.trim()) throw new Error('the demo exclusion policy needs NEXT_PUBLIC_SUPABASE_URL (a local stack)');
  // Each is named: a hosted SUPABASE_URL exported by a shell profile trips this on an otherwise local stack.
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL'] as const) {
    const url = env[name]?.trim();
    if (url && !LOOPBACK.test(url)) {
      throw new Error(`the demo exclusion policy is written only into a local stack: ${name} is not loopback`);
    }
  }
}

type StoredPolicy = { version: number; rules: unknown; requested_by: string };

/** The tenant's latest policy version, or undefined. A read only. */
async function latestPolicy(db: SupabaseClient, tenantId: string): Promise<StoredPolicy | undefined> {
  const { data, error } = await db
    .from(TABLE.DISCOVERY_EXCLUSION_POLICIES)
    .select('version, rules, requested_by')
    .eq('tenant_id', tenantId)
    .order('version', { ascending: false })
    .limit(1);
  if (error) throw new Error(`exclusion policy read failed: ${error.message}`);
  return ((data ?? []) as StoredPolicy[])[0];
}

/** Never supersede a policy someone else wrote: that stack is not a fresh demo stack. */
function assertDemoOwned(current: StoredPolicy | undefined): void {
  if (current && current.requested_by !== DEMO_POLICY_REQUESTED_BY) {
    throw new Error(
      `the tenant's exclusion policy v${current.version} was not written by the demo seed; ` +
        'reset the stack (supabase db reset --local) and seed the demo again',
    );
  }
}

/**
 * The demo replay seed's preflight (round 2, R1), called at the top of seed-discovery's main for
 * `--google-replay --corpus demo`, before the seed writes its registration, sources, invites or consents. Loopback
 * first, before the client exists (`createDb` is not called on a hosted URL); then the committed rules are read and
 * validated, so a bad file stops the seed before any write; then the policy-owner read. Returns the client and the
 * rules the seed goes on to use. ensureDemoExclusionPolicy repeats the loopback and owner checks, and the RPC's
 * expected_version closes the race between this read and the write.
 */
export async function demoSeedPreflight(opts: {
  env: Record<string, string | undefined>;
  tenantId: string;
  createDb: () => SupabaseClient;
  rulesFile?: string;
}): Promise<{ db: SupabaseClient; rules: PolicyRule[] }> {
  assertLoopbackSupabase(opts.env);
  const rules = readDemoPolicyRules(opts.rulesFile);
  const db = opts.createDb();
  assertDemoOwned(await latestPolicy(db, opts.tenantId));
  return { db, rules };
}

/** Whether this seed run is the demo Gmail replay. `--google` wins over `--google-replay` in the seed. */
export function isDemoReplay(argv: readonly string[], selection: CorpusSelection): boolean {
  return argv.includes('--google-replay') && !argv.includes('--google') && selection.corpus === 'demo';
}

/**
 * The seed's one database client. The demo replay goes through the preflight (no client on a hosted URL, rules
 * validated, a foreign policy refused) and also returns its rules; every other path gets a plain client.
 */
export async function openSeedDb(opts: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  selection: CorpusSelection;
  tenantId: string;
  createDb: () => SupabaseClient;
}): Promise<{ db: SupabaseClient; demoRules?: PolicyRule[] }> {
  if (!isDemoReplay(opts.argv, opts.selection)) return { db: opts.createDb() };
  const { db, rules } = await demoSeedPreflight({ env: opts.env, tenantId: opts.tenantId, createDb: opts.createDb });
  return { db, demoRules: rules };
}

export async function ensureDemoExclusionPolicy(
  db: SupabaseClient,
  tenantId: string,
  rules: PolicyRule[],
  env: Record<string, string | undefined> = process.env,
): Promise<{ version: number; written: boolean }> {
  assertLoopbackSupabase(env); // again, for any caller that skipped the preflight
  const current = await latestPolicy(db, tenantId);
  assertDemoOwned(current); // again: the preflight's read may be stale
  if (current && canonical(current.rules) === canonical(rules)) return { version: current.version, written: false };
  const { data: version, error: setError } = await db.rpc('discovery_exclusion_policy_set', {
    p_tenant_id: tenantId,
    p_rules: rules,
    p_expected_version: current?.version ?? 0,
    p_requested_by: DEMO_POLICY_REQUESTED_BY,
  });
  // stale_version (a concurrent writer) or rule_condition_changed (a rule id reused for a new condition).
  if (setError) throw new Error(`the demo exclusion policy was refused: ${setError.message}`);
  return { version: Number(version), written: true };
}
