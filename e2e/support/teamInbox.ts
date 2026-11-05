import { spawnSync } from 'node:child_process';

import { expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { DISCOVERY_AUDIT_ACTION } from '@/lib/constants/audit';
import { SOURCE_KIND } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

import { GMAIL_DEMO_TWIN_DIR } from '../../scripts/discovery/lib/corpusSelect';
import { serviceClient } from './discoveryEvidence';
import { assertLoopbackStack, childEnv } from './discoveryProcess';

/**
 * Support for the team inbox journey (#581 phase 12): one pass of the real worker over the Gmail replay, and the
 * service-role reads that prove what the browser cannot see (the source, its provenance rows, the audit rows). Read-only
 * on the database; the worker pass is the same command the runbook gives (worker/classify.ts --tenant), against the
 * local stack only.
 */

/** The only personal mailbox the journey's stack is seeded with (seed-discovery --personas morgan). */
export const PERSONAL_SOURCES = ['morgan.vale@bank.example'];

/**
 * One pass of the discovery worker over the demo Gmail twin (fixture mode: no credential, no network). Returns nothing
 * of its output: the worker prints counts, and the journey asserts on the database. A failed pass names the worker's
 * fixed failure code, never its message.
 *
 * A new team inbox needs two passes. The provider group is read once at the start of a pass, before the address check
 * runs, so the first pass checks the address and the second reads it. The live worker does the same across two ticks.
 */
export function runWorkerPass(who: string): void {
  // The guard first, then an env built from scratch (childEnv): the worker gets the local stack's values and the
  // fixture reader's, nothing else the Playwright process holds.
  const env = childEnv(who, {
    DISCOVERY_READER_MODE: 'fixture',
    DISCOVERY_GMAIL_REPLAY_DIR: GMAIL_DEMO_TWIN_DIR,
    DISCOVERY_GMAIL_REPLAY_PHASE: 'seeded',
  });
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--tenant', DEV_TENANT_ID], {
    env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const code = /"reason":"([a-z0-9_]+)"/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? 'unknown';
    throw new Error(`${who}: worker/classify exited ${r.status} (${code})`);
  }
}

/** The live mailbox sources of the dev tenant: the guard against a stack seeded with every persona. */
export async function liveMailboxAddresses(): Promise<string[]> {
  const { data, error } = await serviceClient()
    .from(TABLE.CONTENT_SOURCES)
    .select('address')
    .eq('tenant_id', DEV_TENANT_ID)
    .eq('kind', SOURCE_KIND.MAILBOX)
    .is('archived_at', null);
  expect(error, 'read the live mailbox sources').toBeNull();
  return ((data ?? []) as Array<{ address: string }>).map((row) => row.address.toLowerCase()).sort();
}

export type TeamSourceState = {
  sourceId: string;
  status: string;
  backfillCompleted: boolean;
  lastError: string | null;
  /** The subjects of the items the team source holds a provenance row for, sorted. */
  heldSubjects: string[];
};

/** The team source of a registration: its state, and the subjects of the mail it holds. */
export async function teamSourceState(teamMailboxId: string): Promise<TeamSourceState> {
  const db = serviceClient();
  const source = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('id, status, backfill_completed_at, last_error')
    .eq('team_mailbox_id', teamMailboxId)
    .single();
  expect(source.error, 'read the team source').toBeNull();
  const row = source.data as { id: string; status: string; backfill_completed_at: string | null; last_error: string | null };
  const provenance = await db.from(TABLE.SOURCE_ITEM_SOURCES).select('source_item_id').eq('content_source_id', row.id);
  expect(provenance.error, 'read the team source provenance').toBeNull();
  const ids = ((provenance.data ?? []) as Array<{ source_item_id: string }>).map((p) => p.source_item_id);
  let heldSubjects: string[] = [];
  if (ids.length > 0) {
    const items = await db.from(TABLE.SOURCE_ITEMS).select('subject').in('id', ids);
    expect(items.error, 'read the team source items').toBeNull();
    heldSubjects = ((items.data ?? []) as Array<{ subject: string | null }>).map((i) => String(i.subject)).sort();
  }
  return { sourceId: row.id, status: row.status, backfillCompleted: row.backfill_completed_at !== null, lastError: row.last_error, heldSubjects };
}

/** The ids of the items a registration's team source holds a provenance row for (service role): ids only, no mail. */
export async function teamSourceItemIds(teamMailboxId: string): Promise<string[]> {
  const db = serviceClient();
  const source = await db.from(TABLE.CONTENT_SOURCES).select('id').eq('team_mailbox_id', teamMailboxId).single();
  expect(source.error, 'read the team source').toBeNull();
  const provenance = await db
    .from(TABLE.SOURCE_ITEM_SOURCES)
    .select('source_item_id')
    .eq('content_source_id', (source.data as { id: string }).id);
  expect(provenance.error, 'read the team source provenance').toBeNull();
  return ((provenance.data ?? []) as Array<{ source_item_id: string }>).map((p) => p.source_item_id);
}

/** The `discovery.team_mailbox_*` audit rows written since `since`, as the action and its detail. */
export async function teamAuditRows(since: string): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  const actions = [
    DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CONNECTED,
    DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_CHECKED,
    DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_ADDED,
    DISCOVERY_AUDIT_ACTION.TEAM_MAILBOX_MEMBER_REMOVED,
  ];
  const { data, error } = await serviceClient()
    .from(TABLE.AUDIT_LOG)
    .select('action, detail')
    .eq('tenant_id', DEV_TENANT_ID)
    .in('action', actions)
    .gte('ts', since);
  expect(error, 'read the team inbox audit rows').toBeNull();
  return (data ?? []) as Array<{ action: string; detail: Record<string, unknown> }>;
}

/** The firm admins and the CCO told about a connected team inbox (notifications of type mailbox_connected naming it). */
export async function connectNotificationCount(teamMailboxId: string): Promise<number> {
  const { data, error } = await serviceClient()
    .from(TABLE.NOTIFICATIONS)
    .select('id')
    .eq('tenant_id', DEV_TENANT_ID)
    .eq('event_type', 'mailbox_connected')
    .eq('payload->>teamMailboxId', teamMailboxId);
  expect(error, 'read the connect notifications').toBeNull();
  return (data ?? []).length;
}

/**
 * The dev tenant's verified audit chain length: scripts/verify-audit-chain.ts run as a child, after the guard, with an
 * env built from scratch (childEnv). Only its exit code and the dev tenant's `ok (<n> rows)` count are read; its output
 * is never echoed. A broken chain exits non-zero, and so fails here.
 */
export function devAuditChainLength(who: string): number {
  const env = childEnv(who);
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/verify-audit-chain.ts'], {
    env,
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`${who}: verify-audit-chain exited ${r.status}`);
  const ok = new RegExp(`tenant ${DEV_TENANT_ID}: ok \\((\\d+) rows\\)`).exec(r.stdout ?? '');
  if (!ok) throw new Error(`${who}: verify-audit-chain reported no verified chain for the dev tenant`);
  return Number(ok[1]);
}

/** The dev tenant's audit rows written since `since` (service role, a head count), or only the unchained ones. */
export async function devAuditRowsSince(since: string, opts: { unchained?: boolean } = {}): Promise<number> {
  let query = serviceClient()
    .from(TABLE.AUDIT_LOG)
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', DEV_TENANT_ID)
    .gte('ts', since);
  if (opts.unchained) query = query.is('chain_seq', null);
  const { count, error } = await query;
  expect(error, 'count the dev tenant audit rows').toBeNull();
  return count ?? 0;
}

/**
 * A seeded persona's own database session, signed in by password as e2e/auth/session.ts mints one: a client that
 * reads as that user under row-level security. Never signed out (a global sign-out would end the browser's session
 * too); it holds no persisted state and is dropped with the test.
 */
export async function personaClient(who: string, email: string): Promise<SupabaseClient> {
  assertLoopbackStack(who);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!publishableKey || !password) throw new Error(`${who} needs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SEED_PASSWORD`);
  const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${who}: ${email} could not sign in`);
  return client;
}
