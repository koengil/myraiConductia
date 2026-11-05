// Loads a tenant's current exclusion policy (#263). The worker calls it once per
// provider pass and hands the result to the guarded reader.
//
// It never throws for policy content (R5): a missing or invalid policy is a
// value ({ unavailable }), because a throw inside the pass would abort it before
// any source runs, and content_sources.last_error is written only by the sync of
// a source. The guard wrapper turns the value into a refusal on the first read,
// which the admin sees as the source's Last error. A database error still throws.

import type { SupabaseClient } from '@supabase/supabase-js';

import { MAILBOX_PROVIDER, READER_MODE, type MailboxProvider, type ReaderMode } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { dbFailure } from '@/lib/errors/upstream';

import { validatePolicy } from './validate';
import type { ExclusionPolicy, ExclusionUnavailable } from './types';

export async function loadExclusionPolicy(
  db: SupabaseClient,
  tenantId: string,
  mode: ReaderMode,
  provider: MailboxProvider,
): Promise<ExclusionPolicy | ExclusionUnavailable> {
  const { data, error } = await db
    .from(TABLE.DISCOVERY_EXCLUSION_POLICIES)
    .select('version, rules')
    .eq('tenant_id', tenantId)
    .order('version', { ascending: false })
    .limit(1);
  if (error) throw dbFailure('discovery exclusion: policy read', error);
  const row = ((data ?? []) as Array<{ version: number; rules: unknown }>)[0];
  if (!row) {
    // A live tenant must have made one deliberate, audited write, even an empty one. Version 0 (no rules) is only for
    // a pass that cannot read live Gmail: fixture mode, whose Gmail reader replays, and Microsoft in graph mode (the
    // Graph cassette), whose reader enforces no rule and refuses a non-empty policy (R9). The Gmail factory reads live
    // in every mode but fixture, so a Google pass in graph mode needs a stored version too (audit C1).
    const noLiveGmail = mode === READER_MODE.FIXTURE || (mode === READER_MODE.GRAPH && provider === MAILBOX_PROVIDER.MICROSOFT);
    return noLiveGmail ? { version: 0, rules: [] } : { unavailable: 'missing' };
  }
  try {
    return validatePolicy(row.version, row.rules);
  } catch {
    return { unavailable: 'invalid' };
  }
}
