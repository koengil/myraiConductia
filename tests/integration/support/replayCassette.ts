import type { SupabaseClient } from '@supabase/supabase-js';

import { SOURCE_KIND } from '../../../src/lib/constants/discovery';
import type { Cassette } from '../../../scripts/m365/cassette/replayFetch';
import { optInOwners, registerSite, type GuardedTenant } from './guardedTenant';

/*
 * What the cassette-agnostic replay test (discovery-replay-cassette.test.ts, [318 2/6]) needs beyond
 * guardedTenant.ts: the tenant's people and mail domains read from a cassette's manifest at runtime, so no cassette's
 * addresses live in code, and the row counts a replay is judged by. Counts and ids only: nothing here returns, logs
 * or throws an address, subject or text.
 */

/**
 * The synthetic cassette's totals: the siteReader case of discovery-resume.test.ts, the same figures
 * discovery-replay.test.ts asserts. Do not change them to make a replay pass.
 */
export const EXPECTED_SYNTHETIC = { candidates: 2, items: 9, links: 9, ledger: 20, proposedAudit: 2 };

/** The people and domains a cassette's sources need, from its manifest alone. */
export type ReplayPlan = {
  /** Lower-cased mailbox addresses in manifest order, de-duplicated: mailbox i belongs to user i. */
  mailboxes: string[];
  /** The SharePoint site sources, as the manifest names them. */
  sites: string[];
  /** The distinct mail domains of the seated people: what the replay registration reads. */
  domains: string[];
  /**
   * The addresses seated as owners, in order: the mailboxes, or for a site-only cassette one placeholder site owner
   * on a reserved domain (no mailbox owner is seated). The sites belong to the last one.
   */
  people: string[];
};

/** A site-only cassette's one seated owner: nobody's mailbox, on a domain that can never resolve (RFC 2606). */
const SITE_OWNER = 'site-owner@replay.invalid';

export function planFromManifest(manifest: Cassette['manifest']): ReplayPlan {
  const mailboxes = [
    ...new Set(manifest.sources.filter((s) => s.kind === SOURCE_KIND.MAILBOX).map((s) => s.address.trim().toLowerCase())),
  ];
  const sites = manifest.sources.filter((s) => s.kind === SOURCE_KIND.SHAREPOINT_SITE).map((s) => s.address);
  // Counted, not listed: an address is the tenant's data.
  if (mailboxes.length === 0 && sites.length === 0) throw new Error('the cassette names no mailbox or site source');
  // A site-only cassette is valid: its sites need an owner and the registration a domain, and neither is a mailbox.
  const people = mailboxes.length > 0 ? mailboxes : [SITE_OWNER];
  const domains = [...new Set(people.map((address) => address.slice(address.lastIndexOf('@') + 1)))];
  if (people.some((address) => !address.includes('@')) || domains.some((domain) => domain === '')) {
    throw new Error(`${mailboxes.length} mailbox source(s) in the cassette: at least one is not an address`);
  }
  return { mailboxes, sites, domains, people };
}

/**
 * source address (lower-cased) → owner user id. Mailbox i is owned by user i. Every site is owned by the last
 * mailbox's owner, as Storm owns the site in the siteReader case of discovery-resume.test.ts.
 */
export function ownersFor(tenant: GuardedTenant, plan: ReplayPlan): Map<string, string> {
  const siteOwner = tenant.ownerIds[tenant.ownerIds.length - 1];
  return new Map([
    ...plan.mailboxes.map((address, index): [string, string] => [address, tenant.ownerIds[index]]),
    ...plan.sites.map((address): [string, string] => [address.toLowerCase(), siteOwner]),
  ]);
}

export async function registrationStatus(db: SupabaseClient, tenantId: string): Promise<string | undefined> {
  const { data, error } = await db.from('graph_reader_registrations').select('status').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error(`registration read failed: ${error.message}`);
  return (data as { status: string } | null)?.status;
}

export async function setRegistration(db: SupabaseClient, tenantId: string, status: 'active' | 'disabled'): Promise<void> {
  const { error } = await db.from('graph_reader_registrations').update({ status }).eq('tenant_id', tenantId);
  if (error) throw new Error(`registration ${status} failed: ${error.message}`);
}

/**
 * The owners' opt-in and the sites' registration, for a tenant replay has just seeded (disabled at rest). The opt-in
 * needs an active registration, so it happens while the registration is briefly active, as a worker would see it.
 */
export async function admitReplayTenant(db: SupabaseClient, tenant: GuardedTenant, plan: ReplayPlan): Promise<void> {
  await setRegistration(db, tenant.id, 'active');
  try {
    await optInOwners(tenant);
  } finally {
    await setRegistration(db, tenant.id, 'disabled');
  }
  for (const address of plan.sites) await registerSite(tenant, address);
}

type CountQuery = ReturnType<ReturnType<SupabaseClient['from']>['select']>;

/** Row counts of one replayed tenant (the figures of discovery-replay.test.ts's counts, plus nothing else). */
export async function replayedCounts(db: SupabaseClient, tenantId: string) {
  const exact = async (table: string, filter: (q: CountQuery) => CountQuery) => {
    const { count, error } = await filter(db.from(table).select('*', { count: 'exact', head: true }));
    // A failed count must fail the test, never read as 0: the owner pastes these figures.
    if (error) throw new Error(`${table} count failed: ${error.message}`);
    if (count === null) throw new Error(`${table} count returned no count`);
    return count;
  };
  const ids = async (table: string) => {
    const { data, error } = await db.from(table).select('id').eq('tenant_id', tenantId);
    if (error) throw new Error(`${table} lookup failed: ${error.message}`);
    return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
  };
  const candidateIds = await ids('deal_candidates');
  const sourceIds = await ids('content_sources');
  return {
    candidates: candidateIds.length,
    items: await exact('source_items', (q) => q.eq('tenant_id', tenantId)),
    links: candidateIds.length ? await exact('evidence_links', (q) => q.in('candidate_id', candidateIds)) : 0,
    ledger: sourceIds.length ? await exact('routing_ledger', (q) => q.in('source_id', sourceIds)) : 0,
    proposedAudit: await exact('audit_log', (q) =>
      q.eq('tenant_id', tenantId).eq('action', 'discovery.candidate_proposed'),
    ),
  };
}
