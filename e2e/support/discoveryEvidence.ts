import { expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

import { assertLoopbackStack } from './discoveryProcess';

/**
 * Service-role reads for the discovery journey. The MD's own session proves what
 * the MD can see; these prove what was written, including the audit rows and the
 * correction log, which no user route lists. Read-only except rewindSources, and
 * refused off loopback.
 */
export function serviceClient(): SupabaseClient {
  // The same parsed guard as the spawned scripts: loopback only, no userinfo, and w9-m365cap only under the rehearsal.
  assertLoopbackStack('the discovery evidence reads');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('the discovery evidence reads need SUPABASE_SECRET_KEY');
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

export type CorrectionRow = {
  action: string;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  actor_id: string;
  deal_id?: string | null;
  created_at: string;
};

export async function correctionsFor(candidateId: string, action: string): Promise<CorrectionRow[]> {
  const { data, error } = await serviceClient()
    .from(TABLE.CORRECTIONS)
    .select('action, reason, before, after, actor_id, deal_id, created_at')
    .eq('candidate_id', candidateId)
    .eq('action', action)
    .order('created_at', { ascending: true });
  expect(error, `read corrections for ${candidateId}`).toBeNull();
  return (data ?? []) as CorrectionRow[];
}

/** `discovery.correction` audit rows for one candidate (ids only in the detail, never a name). */
export async function correctionAudit(candidateId: string, action: string, since: string) {
  const { data, error } = await serviceClient()
    .from(TABLE.AUDIT_LOG)
    .select('action, detail, ts, actor_id')
    .eq('action', 'discovery.correction')
    .eq('detail->>candidateId', candidateId)
    .eq('detail->>action', action)
    .gte('ts', since);
  expect(error, `read discovery.correction audit for ${candidateId}`).toBeNull();
  return data ?? [];
}

export type CandidateState = {
  proposed_name: string;
  discovery_state: string;
  merged_into_id: string | null;
  station_override_step_id: string | null;
};

export async function candidateState(candidateId: string): Promise<CandidateState> {
  const { data, error } = await serviceClient()
    .from(TABLE.DEAL_CANDIDATES)
    .select('proposed_name, discovery_state, merged_into_id, station_override_step_id')
    .eq('id', candidateId)
    .single();
  expect(error, `read candidate ${candidateId}`).toBeNull();
  return data as CandidateState;
}

/** The subjects of a candidate's live (not rejected) email links, sorted: titles, never counts. */
export async function liveLinkSubjects(candidateId: string): Promise<string[]> {
  const db = serviceClient();
  const links = await db.from(TABLE.EVIDENCE_LINKS).select('source_item_id').eq('candidate_id', candidateId).neq('state', 'rejected');
  expect(links.error, `read links of ${candidateId}`).toBeNull();
  const ids = (links.data ?? []).map((l) => l.source_item_id as string);
  if (ids.length === 0) return [];
  const items = await db.from(TABLE.SOURCE_ITEMS).select('subject').in('id', ids);
  expect(items.error, `read subjects of ${candidateId}`).toBeNull();
  return (items.data ?? []).map((i) => String(i.subject)).sort();
}

/**
 * Forgets every mailbox source's checkpoint of the dev tenant, so the next
 * seed-discovery reads each mailbox from the start, as a full re-run does. The
 * fixture reader otherwise serves only what is past the checkpoint.
 */
export async function rewindSources(): Promise<void> {
  const { error } = await serviceClient()
    .from(TABLE.CONTENT_SOURCES)
    .update({ delta_checkpoint: null, backfill_completed_at: null })
    .eq('tenant_id', DEV_TENANT_ID);
  expect(error, 'rewind the mailbox checkpoints').toBeNull();
}
