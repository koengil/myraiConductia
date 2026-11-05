import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { FlagKey } from './keys';
import type { FlagSource } from './source';
import type { FlagsFetcher } from './resolveFlags';
import { dbFailure } from '@/lib/errors/upstream';

// The production FlagSource. Reads the stored `enabled` value from feature_flags
// via the shared admin client (secret key, bypasses RLS — from the Supabase
// foundation in src/lib/supabase/). Returns null when the flag has no row; errors
// propagate so `isEnabled` can fail closed (ADR-0007).
export const supabaseFlagSource: FlagSource = {
  async getEnabled(key: FlagKey): Promise<boolean | null> {
    const { data, error } = await createSupabaseAdminClient()
      .from('feature_flags')
      .select('enabled')
      .eq('key', key)
      .maybeSingle();
    if (error) throw dbFailure('Flag lookup', error);
    return data ? (data.enabled as boolean) : null;
  },
};

// The same read through a service-role client the caller already holds, for
// non-request code (the classification worker) that owns its own client.
export function flagSourceFor(db: SupabaseClient): FlagSource {
  return {
    async getEnabled(key: FlagKey): Promise<boolean | null> {
      const { data, error } = await db.from('feature_flags').select('enabled').eq('key', key).maybeSingle();
      if (error) throw dbFailure('Flag lookup', error);
      return data ? ((data as { enabled: boolean }).enabled) : null;
    },
  };
}

// Batch fetcher for resolveFlags(): one query for all keys (server-only). Used by
// the hydration path so a page resolves every flag in a single round-trip.
export const supabaseFlagsFetcher: FlagsFetcher = async (keys) => {
  const { data, error } = await createSupabaseAdminClient()
    .from('feature_flags')
    .select('key, enabled')
    .in('key', keys);
  if (error) throw dbFailure('Flag lookup', error);
  return (data ?? []) as Array<{ key: string; enabled: boolean }>;
};
