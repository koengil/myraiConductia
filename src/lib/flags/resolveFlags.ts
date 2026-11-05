import { errorCodeOf } from '@/lib/errors/upstream';

import { FLAG_REGISTRY, type FlagKey } from './keys';

// A resolved snapshot of every flag's enabled state, passed from server to client.
export type FlagMap = Record<FlagKey, boolean>;

// Fetches the stored rows for the given keys (only the rows that exist). Decoupled
// from any backend so resolveFlags stays pure and testable; the Supabase-backed
// implementation lives in supabaseSource.ts (server-only).
export type FlagsFetcher = (
  keys: FlagKey[],
) => Promise<Array<{ key: string; enabled: boolean }>>;

// Resolve every registered flag to a boolean in a single fetch. Fail-closed: any
// flag with no row, an unknown key, or a fetch error defaults to false (ADR-0007).
export async function resolveFlags(fetcher: FlagsFetcher): Promise<FlagMap> {
  const keys = Object.keys(FLAG_REGISTRY) as FlagKey[];
  const map = Object.fromEntries(keys.map((k) => [k, false])) as FlagMap;
  try {
    const rows = await fetcher(keys);
    for (const row of rows) {
      if (row.key in map) map[row.key as FlagKey] = row.enabled === true;
    }
  } catch (error) {
    console.warn(
      '[flags] resolveFlags failed; all flags default to false (fail-closed):',
      errorCodeOf(error),
    );
  }
  return map;
}
