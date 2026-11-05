/**
 * Sets ONLY the named feature flags on the #162 throwaway stack, to the given
 * values. Never enable-flags.ts, which turns on every FLAG_REGISTRY key: the
 * harness must know exactly which flags each measurement ran under.
 *
 *   with-local-stack.sh --write node --import tsx scripts/perf/set-local-flags.ts gate0_api_create=1 workbench_top_nav=0
 *   with-local-stack.sh node --import tsx scripts/perf/set-local-flags.ts --show
 *
 * Run under scripts/perf/with-local-stack.sh (its preload refuses any
 * NEXT_PUBLIC_SUPABASE_URL but the throwaway stack's before this module
 * loads). Writing flags also needs --write (assertWriteChecked: the running
 * containers were confirmed as this stack's).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { FLAG_REGISTRY, type FlagKey } from '../../src/lib/flags/keys';
import { assertWriteChecked } from './localStack.mjs';

/** The flags the rail measurement controls. Anything else is refused. */
export const RAIL_FLAG_KEYS = [
  'gate0_api_create',
  'platform_onboarding',
  'project_rail_model',
  'workbench_top_nav',
] as const satisfies readonly FlagKey[];

export type RailFlagKey = (typeof RAIL_FLAG_KEYS)[number];
export type FlagSnapshot = Record<string, boolean>;

export function localAdmin(env: NodeJS.ProcessEnv = process.env): SupabaseClient {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function setLocalFlags(
  admin: SupabaseClient,
  values: Partial<Record<RailFlagKey, boolean>>,
): Promise<void> {
  assertWriteChecked(process.env);
  const rows = Object.entries(values).map(([key, enabled]) => {
    if (!(RAIL_FLAG_KEYS as readonly string[]).includes(key)) {
      throw new Error(`set-local-flags: ${key} is not a rail measurement flag`);
    }
    return {
      key,
      description: FLAG_REGISTRY[key as RailFlagKey].description,
      enabled: Boolean(enabled),
    };
  });
  if (rows.length === 0) return;
  const { error } = await admin.from('feature_flags').upsert(rows, { onConflict: 'key' });
  if (error) throw error;
}

/** The live feature_flags table, every row, for the run's JSON. */
export async function readFlagSnapshot(admin: SupabaseClient): Promise<FlagSnapshot> {
  const { data, error } = await admin.from('feature_flags').select('key, enabled').order('key');
  if (error) throw error;
  return Object.fromEntries(
    ((data ?? []) as Array<{ key: string; enabled: boolean }>).map((row) => [row.key, row.enabled]),
  );
}

function parseArgs(args: string[]): Partial<Record<RailFlagKey, boolean>> {
  const values: Partial<Record<RailFlagKey, boolean>> = {};
  for (const arg of args) {
    const match = /^([a-z0-9_]+)=(0|1|true|false|on|off)$/.exec(arg);
    if (!match) throw new Error(`set-local-flags: expected key=on|off, got "${arg}"`);
    values[match[1] as RailFlagKey] = ['1', 'true', 'on'].includes(match[2]);
  }
  return values;
}

async function main(): Promise<void> {
  const admin = localAdmin();
  const args = process.argv.slice(2);
  if (!args.includes('--show')) await setLocalFlags(admin, parseArgs(args));
  const snapshot = await readFlagSnapshot(admin);
  const on = Object.entries(snapshot)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
  console.log(`flags on: ${on.length ? on.join(', ') : '(none)'}`);
}

if (process.argv[1]?.endsWith('set-local-flags.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
