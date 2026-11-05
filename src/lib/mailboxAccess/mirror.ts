// The provider group mirrors allowed_mailboxes and allowed_team_mailboxes (#262, R16; #581). Each pass reads
// the intersection, records drift, and fails closed when the group cannot be
// read. #259 (Google Group) and #275 (Exchange group) implement the mirror.

import type { SupabaseClient } from '@supabase/supabase-js';

import { isProductionAppEnv } from '@/lib/appEnv';
import { DRIFT_STATUS, type DriftStatus, type MailboxProvider } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';

import type { ProviderRefusalReason } from './guard';

/**
 * A group member: a bare address (Google, fixture), or a directory user object (the Exchange mirror, #275).
 * Shared, room and equipment mailboxes are user objects too (design R12). Lowercased.
 */
export type MirrorMember = string | { id: string; mail: string | null; upn: string };

/** The one directory object an allowlisted address is bound to (design R4). */
export type ReadKey = { upn: string; id: string };

export interface ProviderAllowlistMirror {
  listMembers(tenantId: string, provider: MailboxProvider): Promise<MirrorMember[]>;
}

export type ReadableMailboxes = {
  status: DriftStatus;
  /** The bound addresses only. */
  readable: ReadonlySet<string>;
  /** Allowlisted addresses not in the group, and those that bind to no single member (ambiguous). */
  missingInGroup: string[];
  extraInGroup: string[];
  /** For the guarded reader: why the group excludes an address, or null. */
  providerCheck: (address: string) => ProviderRefusalReason | null;
  /**
   * The directory object a live Graph read of this mailbox must reach: the bound member's UPN (the path key) and
   * object id (checked before the first page, #275 slice 4). Null unless the address is bound to exactly one
   * member; always null for string members and when the status is 'unavailable'.
   */
  readKey: (address: string) => ReadKey | null;
};

/** A member as binding sees it. A string member has no object id: it binds by equality, as it always has. */
type BindableMember = { id: string | null; mail: string | null; upn: string };

const lowered = (value: string) => value.trim().toLowerCase();

/** Every member lowercased; string members deduplicated, as the set they were compared as. A malformed object throws. */
function bindableMembers(members: MirrorMember[]): BindableMember[] {
  const strings = new Set<string>();
  const objects: BindableMember[] = [];
  for (const member of members) {
    if (typeof member === 'string') {
      strings.add(lowered(member));
      continue;
    }
    const { id, mail, upn } = member;
    if (typeof id !== 'string' || !id.trim() || typeof upn !== 'string' || !upn.trim()) {
      throw new Error('a group member has no object id or UPN');
    }
    if (mail !== null && typeof mail !== 'string') throw new Error('a group member has a malformed mail address');
    objects.push({ id: id.trim(), mail: mail && mail.trim() ? lowered(mail) : null, upn: lowered(upn) });
  }
  return [...[...strings].map((address) => ({ id: null, mail: address, upn: address })), ...objects];
}

/**
 * Design R4: an allowlisted address is bound only when exactly one member has it as mail, and no other member has
 * it as UPN. A UPN-only hit, another member's UPN, or two mail hits is ambiguous: never read, counted as missing.
 * A shared mailbox binds by its mail even when its UPN differs. Returns the bound member, 'missing' or 'ambiguous'.
 */
function bind(address: string, members: readonly BindableMember[]): BindableMember | 'missing' | 'ambiguous' {
  const byMail = members.filter((m) => m.mail === address);
  const byUpn = members.filter((m) => m.upn === address);
  if (byMail.length === 1 && byUpn.every((m) => m === byMail[0])) return byMail[0];
  if (byMail.length === 0 && byUpn.length === 0) return 'missing';
  return 'ambiguous';
}

// Paged with a stable order: one unpaged select stops at the API row limit
// (1,000 by default) and would misreport drift (review round 1).
const PAGE = 500;

/** One view's addresses for a tenant and provider, paged. */
async function pagedAddresses(
  db: SupabaseClient,
  view: typeof TABLE.ALLOWED_MAILBOXES | typeof TABLE.ALLOWED_TEAM_MAILBOXES,
  tenantId: string,
  provider: MailboxProvider,
  into: Set<string>,
): Promise<void> {
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(view)
      .select('address')
      .eq('tenant_id', tenantId)
      .eq('provider', provider)
      .order('address')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`allowlist lookup failed (${errorCodeOf(error)})`);
    const rows = (data ?? []) as Array<{ address: string }>;
    for (const row of rows) into.add(row.address.toLowerCase());
    if (rows.length < PAGE) return;
  }
}

// Only this provider's mailboxes: a Google address is not "missing" from the
// Exchange group (audit round 1, item 22). allowed_mailboxes.provider comes
// from the provider whose registered domains match the address (C6), so a
// domain registered under both providers is counted by each.
//
// The rule (audit round 2, item 10): the provider group of an address is chosen
// by its DOMAIN, not by the source that carries it. A Google source on a
// Microsoft-registered domain therefore appears in the Exchange mirror's
// expected set (as missing_in_group if the group lacks it), while in-app access
// to that source fails closed (registration_inactive, and RLS hides it). This
// is deliberate: #275 keeps the query as it is (design R7).
//
// The expected set is the union of two views (#581): the people who opted in
// (allowed_mailboxes) and the team inboxes an admin registered and the Directory
// confirmed (allowed_team_mailboxes). The team view has no time term, so a pause, an
// outage or a stale check never moves an address in or out of this set, and so never
// flips drift or the group-removal bookkeeping. Whether a team inbox is fresh enough
// to read is the guard's question alone, asked page by page.
async function allowedAddresses(db: SupabaseClient, tenantId: string, provider: MailboxProvider): Promise<Set<string>> {
  const out = new Set<string>();
  await pagedAddresses(db, TABLE.ALLOWED_MAILBOXES, tenantId, provider, out);
  await pagedAddresses(db, TABLE.ALLOWED_TEAM_MAILBOXES, tenantId, provider, out);
  return out;
}

export async function readableMailboxes(
  db: SupabaseClient,
  tenantId: string,
  provider: MailboxProvider,
  mirror: ProviderAllowlistMirror,
  // recordPresence false: the drift is recorded, but no address as seen in the group, so no group-absence row is
  // started and group removal (#461) cannot withdraw it. The worker passes false for live Microsoft (D100).
  options: { recordPresence?: boolean } = {},
): Promise<ReadableMailboxes> {
  const allowed = await allowedAddresses(db, tenantId, provider);
  let result: ReadableMailboxes;
  try {
    const members = bindableMembers(await mirror.listMembers(tenantId, provider));
    const keys = new Map<string, ReadKey | null>();
    const bound = new Set<BindableMember>();
    const missingInGroup: string[] = [];
    for (const address of allowed) {
      const member = bind(address, members);
      if (member === 'missing' || member === 'ambiguous') {
        missingInGroup.push(address);
        continue;
      }
      bound.add(member);
      keys.set(address, member.id === null ? null : { upn: member.upn, id: member.id });
    }
    const readable: ReadonlySet<string> = new Set(keys.keys());
    missingInGroup.sort();
    // A member bound to no allowlisted address, by the address an admin knows it by.
    const extraInGroup = [...new Set(members.filter((m) => !bound.has(m)).map((m) => m.mail ?? m.upn))].sort();
    result = {
      status: missingInGroup.length || extraInGroup.length ? DRIFT_STATUS.DRIFT : DRIFT_STATUS.IN_SYNC,
      readable,
      missingInGroup,
      extraInGroup,
      providerCheck: (address) => (readable.has(address) ? null : 'not_in_provider_group'),
      readKey: (address) => {
        const key = typeof address === 'string' ? keys.get(address.toLowerCase()) : undefined;
        return key ? { upn: key.upn, id: key.id } : null;
      },
    };
  } catch {
    // Any failure to read the group fails closed, a timeout included (a TimeoutError from the directory token,
    // generateAccessToken or the members read): the pass reads nothing as mirror_unavailable, records no last_error
    // and is not retried; the source waits for the next tick.
    result = {
      status: DRIFT_STATUS.UNAVAILABLE,
      readable: new Set(),
      missingInGroup: [],
      extraInGroup: [],
      providerCheck: () => 'mirror_unavailable',
      readKey: () => null,
    };
  }
  const { error } = await db.rpc('discovery_record_allowlist_drift', {
    p_tenant_id: tenantId,
    p_provider: provider,
    p_status: result.status,
    p_missing: result.missingInGroup,
    p_extra: result.extraInGroup,
    // The addresses this check saw in the group (#461): only an address seen there can later be withdrawn for leaving it.
    p_present: options.recordPresence === false ? [] : [...result.readable].sort(),
  });
  if (error) throw new Error(`drift record failed (${errorCodeOf(error)})`);
  return result;
}

/**
 * The fixture mirror: by default the group holds exactly allowed_mailboxes.
 * Tests add or drop members, or make it fail. Refused in production.
 */
export function createFixtureAllowlistMirror(
  db: SupabaseClient,
  options: { add?: string[]; drop?: string[]; fail?: boolean } = {},
): ProviderAllowlistMirror {
  if (isProductionAppEnv()) throw new Error('The fixture allowlist mirror is refused in production');
  return {
    async listMembers(tenantId, provider) {
      if (options.fail) throw new Error('fixture mirror unavailable');
      const members = await allowedAddresses(db, tenantId, provider);
      for (const address of options.drop ?? []) members.delete(address.toLowerCase());
      for (const address of options.add ?? []) members.add(address.toLowerCase());
      return [...members];
    },
  };
}
