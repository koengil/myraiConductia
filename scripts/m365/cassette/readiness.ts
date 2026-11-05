// What a live recording would read, decided once (#318). `--preflight` prints it and the capture reads exactly
// the sources it marks ready, so the two cannot disagree: there is no second implementation of "ready".
//
// It makes the worker's own checks and no mail request: the exclusion policy, the provider group (read through the
// mirror it is handed, which records drift in the database) and, per source, the halt and the mailbox guard, asked
// as for any read, so a refusal is recorded and audited under the recorder's caller. What it reports about a source
// is a count under a fixed reason code, so a report carries no value of the tenant.
//
// It imports the guard and the mirror directly, not the mailboxAccess index, so loading it does not load
// readers.ts: the recorder claims the reader capability first (record-graph.ts).

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DRIFT_STATUS,
  HISTORY_WINDOW_EXCEEDED,
  M365_RECORDER_SERVICE_IDENTITY,
  MAILBOX_GUARD_PURPOSE,
  MAILBOX_PROVIDER,
  MAILBOX_REFUSAL_REASON,
  READER_MODE,
  SOURCE_KIND,
  SOURCE_STATUS,
  type DriftStatus,
  type SourceKind,
  type SourceRefusalReason,
} from '../../../src/lib/constants/discovery';
import { TABLE } from '../../../src/lib/constants/tables';
import { isUnavailable, type ExclusionPolicy } from '../../../src/lib/discovery/exclusion/types';
import { loadExclusionPolicy } from '../../../src/lib/discovery/exclusion/load';
import { errorCodeOf } from '../../../src/lib/errors/upstream';
import { assertSourceAllowed, MailboxAccessRefusedError } from '../../../src/lib/mailboxAccess/guard';
import { readableMailboxes, type ProviderAllowlistMirror, type ReadableMailboxes } from '../../../src/lib/mailboxAccess/mirror';
import type { SourceRow } from '../../../src/lib/mailboxAccess/readers';

/** Why the whole run reads nothing. Fixed codes, checked in this order. */
export const RUN_BLOCK = {
  NO_SCOPE_GROUP: 'no_scope_group',
  NO_EXCLUSION_POLICY: 'no_exclusion_policy',
  INVALID_EXCLUSION_POLICY: 'invalid_exclusion_policy',
  EXCLUSION_POLICY_NOT_EMPTY: 'exclusion_policy_not_empty',
  GROUP_UNAVAILABLE: 'group_unavailable',
} as const;
export type RunBlock = (typeof RUN_BLOCK)[keyof typeof RUN_BLOCK];

/** Why one source is not read: halted by the history window, or the guard's own refusal reason. */
export const SOURCE_HALTED = 'halted';
export type NotReadyReason = typeof SOURCE_HALTED | SourceRefusalReason;

/** A source the capture reads. `recordAs` is the address the cassette records it under (see below). */
export type ReadySource = { row: SourceRow; recordAs: string };

export type Readiness = {
  /** Why the run reads nothing, or null. A blocked run has no ready source and no `pass`. */
  blocked: RunBlock | null;
  /** The provider group's drift status, or null when the run was blocked before the group was read. */
  group: DriftStatus | null;
  /** In the guard's order (address). The capture reads these and no other. */
  ready: ReadySource[];
  /** Count of the sources that are not read, by reason. */
  notReady: Partial<Record<NotReadyReason, number>>;
  /** Ready mailboxes recorded under their UPN because it differs from the stored address. */
  recordedUnderUpn: number;
  /** What the capture builds its guarded context from: the same group and policy the verdicts came from. */
  pass: { group: ReadableMailboxes; policy: ExclusionPolicy } | null;
};

export type ReadinessRegistration = { scopeGroupId: string | null };

type SourceDbRow = { id: string; kind: SourceKind; address: string; owner_user_id: string | null; last_error: string | null };

// An Entra object id: the same shape readers.ts accepts in a read key, so a key this module calls usable is one the
// guarded read does not refuse as mirror_unavailable.
const OBJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The UPN a mailbox is read and recorded under, or null when the group gives no usable key for it. */
function usableUpn(group: ReadableMailboxes, address: string): string | null {
  let key: unknown;
  try {
    key = group.readKey(address);
  } catch {
    return null;
  }
  if (key === null || typeof key !== 'object') return null;
  const { upn, id } = key as { upn?: unknown; id?: unknown };
  if (typeof upn !== 'string' || upn.trim() === '' || typeof id !== 'string' || !OBJECT_ID.test(id.trim())) return null;
  return upn.trim().toLowerCase();
}

const blocked = (reason: RunBlock, group: DriftStatus | null): Readiness => ({
  blocked: reason,
  group,
  ready: [],
  notReady: {},
  recordedUnderUpn: 0,
  pass: null,
});

/** The tenant's active Microsoft sources, halted ones included (they are counted), in address order. */
async function activeSources(db: SupabaseClient, tenantId: string): Promise<SourceDbRow[]> {
  const { data, error } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('id, kind, address, owner_user_id, last_error')
    .eq('tenant_id', tenantId)
    .eq('provider', MAILBOX_PROVIDER.MICROSOFT)
    .eq('status', SOURCE_STATUS.ACTIVE)
    .order('address');
  if (error) throw new Error(`content source lookup failed (${errorCodeOf(error)})`);
  return ((data ?? []) as SourceDbRow[]).filter((row) => row.kind === SOURCE_KIND.MAILBOX || row.kind === SOURCE_KIND.SHAREPOINT_SITE);
}

/**
 * Whole run, then per source.
 *
 * The whole run reads nothing when the registration records no scope group, when the tenant has no stored exclusion
 * policy (a live pass has no version-0 default), a policy that does not validate, or a non-empty one (the Graph
 * reader enforces no rule, so a rule is never silently ignored), or when the provider group cannot be read.
 *
 * Per source, in order: halted (history_window_exceeded), then the mailbox guard with the group's reason, asked as
 * the guarded read asks it and audited the same. A mailbox the group binds but gives no usable key is refused as
 * mirror_unavailable, which is what the guarded read does with it.
 *
 * `recordAs`: a mailbox is read by the UPN of the directory object it is bound to (#275), and the cassette records
 * it under that UPN, so replay asks the same URLs. For most mailboxes the UPN is the stored address; a shared
 * mailbox may differ, and `recordedUnderUpn` counts those. A site has no key and is recorded under its address.
 */
export async function assessReadiness(
  db: SupabaseClient,
  tenantId: string,
  registration: ReadinessRegistration,
  mirror: ProviderAllowlistMirror,
): Promise<Readiness> {
  if (!registration.scopeGroupId?.trim()) return blocked(RUN_BLOCK.NO_SCOPE_GROUP, null);

  const policy = await loadExclusionPolicy(db, tenantId, READER_MODE.LIVE, MAILBOX_PROVIDER.MICROSOFT);
  if (isUnavailable(policy)) {
    return blocked(policy.unavailable === 'missing' ? RUN_BLOCK.NO_EXCLUSION_POLICY : RUN_BLOCK.INVALID_EXCLUSION_POLICY, null);
  }
  if (policy.rules.length > 0) return blocked(RUN_BLOCK.EXCLUSION_POLICY_NOT_EMPTY, null);

  const group = await readableMailboxes(db, tenantId, MAILBOX_PROVIDER.MICROSOFT, mirror);
  if (group.status === DRIFT_STATUS.UNAVAILABLE) return blocked(RUN_BLOCK.GROUP_UNAVAILABLE, group.status);

  const ready: ReadySource[] = [];
  const notReady: Partial<Record<NotReadyReason, number>> = {};
  const refuse = (reason: NotReadyReason) => {
    notReady[reason] = (notReady[reason] ?? 0) + 1;
  };
  let recordedUnderUpn = 0;

  for (const source of await activeSources(db, tenantId)) {
    if (source.last_error === HISTORY_WINDOW_EXCEEDED) {
      refuse(SOURCE_HALTED);
      continue;
    }
    const isMailbox = source.kind === SOURCE_KIND.MAILBOX;
    const upn = isMailbox ? usableUpn(group, source.address) : null;
    // The group's reason, or mirror_unavailable for a bound mailbox with no usable key; a site has no group.
    const providerReason = !isMailbox
      ? null
      : (group.providerCheck(source.address.toLowerCase()) ?? (upn === null ? MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE : null));
    try {
      await assertSourceAllowed(
        tenantId,
        { kind: source.kind, address: source.address, ownerUserId: source.owner_user_id },
        {
          purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ,
          caller: M365_RECORDER_SERVICE_IDENTITY,
          provider: MAILBOX_PROVIDER.MICROSOFT,
          providerReason,
        },
      );
    } catch (error) {
      // A refusal is a verdict; no_capability is a wiring fault and a failed guard call is no verdict at all.
      if (error instanceof MailboxAccessRefusedError && error.reason !== 'no_capability') {
        refuse(error.reason);
        continue;
      }
      throw error;
    }
    // The guard allowed it but the group does not: refused here as the guarded read refuses it.
    if (providerReason !== null) {
      refuse(providerReason);
      continue;
    }
    const recordAs = isMailbox ? upn! : source.address;
    if (isMailbox && recordAs !== source.address.toLowerCase()) recordedUnderUpn += 1;
    ready.push({
      row: {
        id: source.id,
        tenantId,
        kind: source.kind,
        provider: MAILBOX_PROVIDER.MICROSOFT,
        address: source.address,
        ownerUserId: source.owner_user_id,
        deltaCheckpoint: null,
      },
      recordAs,
    });
  }
  return { blocked: null, group: group.status, ready, notReady, recordedUnderUpn, pass: { group, policy } };
}

/**
 * The lines `--preflight` prints: fixed words and counts, never an address, a subject, an id, a token or a URL.
 * Reason codes are the guard's own vocabulary.
 */
export function readinessLines(readiness: Readiness): string[] {
  const reasons = Object.entries(readiness.notReady).sort(([a], [b]) => a.localeCompare(b));
  const notReadyTotal = reasons.reduce((sum, [, count]) => sum + count, 0);
  return [
    `provider group ${readiness.group ?? 'not read'}`,
    ...(readiness.blocked ? [`run blocked: ${readiness.blocked}`] : []),
    `sources ready ${readiness.ready.length}`,
    `sources not ready ${notReadyTotal}`,
    ...reasons.map(([reason, count]) => `  ${reason} ${count}`),
    `mailboxes recorded under their UPN ${readiness.recordedUnderUpn}`,
  ];
}
