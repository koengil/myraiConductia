// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The guard and the group read live
// beside the readers.
import '../../../src/lib/mailboxAccess/readers';

import type { SupabaseClient } from '@supabase/supabase-js';

import { MAILBOX_GUARD_PURPOSE, MAILBOX_PROVIDER, SOURCE_KIND } from '../../../src/lib/constants/discovery';
import { TABLE } from '../../../src/lib/constants/tables';
import {
  assertMailboxAllowed,
  MailboxAccessRefusedError,
  readableMailboxes,
  type ProviderAllowlistMirror,
  type ProviderRefusalReason,
} from '../../../src/lib/mailboxAccess';
import { PROBE_ERROR_CODE, ProbeCodeError, type ProbeGroupRead } from './probe';

// The one place the probe's guard calls are built (#344, design R15, round 2 blocker 1). Each
// guard call is the worker's: provider google, the address's content_sources owner bound (the
// worker binds the source row's owner), and the provider-group decision from the same
// readableMailboxes(...).providerCheck the worker's providerPass builds. Every failure is a
// fixed code; no database or Google message leaves this module.

/** The audit_log.service_identity of the probe's refusals, beside the worker's 'discovery-worker'. */
export const PROBE_GUARD_CALLER = 'google-probe';

export type ProbeGuard = {
  /** The refusal reason for the address, or null when admitted. Throws a ProbeCodeError when it cannot be asked. */
  guardFor: (address: string) => Promise<string | null>;
  /** The group read, once per guard (memoised): member count and the providerCheck the guard applies. */
  group: () => Promise<ProbeGroupRead>;
  /**
   * True when the address is no users, invites or allowed_mailboxes row in any tenant, and no
   * content_sources mailbox row in this tenant (a source is a mailbox Conductia reads or has read).
   */
  registeredOutOfScope: (address: string) => Promise<boolean>;
};

const lower = (address: string) => address.trim().toLowerCase();

/**
 * Rows whose address column equals `address` case-insensitively. ilike narrows in the database
 * (the probe's addresses carry no `%` or `*`; an `_` may over-match), and the exact comparison here
 * keeps only the address itself.
 */
async function rowsWithAddress<T extends Record<string, unknown>>(
  query: PromiseLike<{ data: unknown; error: unknown }>,
  column: keyof T & string,
  address: string,
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error('lookup failed');
  return ((data ?? []) as T[]).filter((row) => typeof row[column] === 'string' && lower(row[column] as string) === address);
}

export function buildProbeGuard(db: SupabaseClient, tenantId: string, mirror: ProviderAllowlistMirror): ProbeGuard {
  let groupRead: Promise<ProbeGroupRead> | null = null;

  async function readGroup(): Promise<ProbeGroupRead> {
    // readableMailboxes turns a mirror failure into providerCheck = mirror_unavailable, as the
    // worker needs. The probe also needs the failure itself, for P08 and to fail P14 closed.
    const mirrorFailure: { failed: boolean; error?: unknown } = { failed: false };
    const recording: ProviderAllowlistMirror = {
      async listMembers(tenant, provider) {
        try {
          return await mirror.listMembers(tenant, provider);
        } catch (error) {
          mirrorFailure.failed = true;
          mirrorFailure.error = error;
          throw error;
        }
      },
    };
    let read;
    try {
      read = await readableMailboxes(db, tenantId, MAILBOX_PROVIDER.GOOGLE, recording);
    } catch {
      // The allowlist page or the drift record failed: a database message, never printed.
      throw new ProbeCodeError(PROBE_ERROR_CODE.GROUP_UNAVAILABLE);
    }
    if (mirrorFailure.failed) throw new ProbeCodeError(PROBE_ERROR_CODE.GROUP_UNAVAILABLE, mirrorFailure.error);
    return { count: read.readable.size + read.extraInGroup.length, providerCheck: read.providerCheck };
  }

  const group = (): Promise<ProbeGroupRead> => {
    groupRead ??= readGroup();
    return groupRead;
  };

  /** The address's content_sources mailbox owner in the tenant, or null when it has no source (the guard says no_source). */
  async function ownerOf(address: string): Promise<string | null> {
    let rows: Array<{ address: string; owner_user_id: string | null }>;
    try {
      rows = await rowsWithAddress(
        db
          .from(TABLE.CONTENT_SOURCES)
          .select('address, owner_user_id')
          .eq('tenant_id', tenantId)
          .eq('kind', SOURCE_KIND.MAILBOX)
          .ilike('address', address),
        'address',
        address,
      );
    } catch {
      throw new ProbeCodeError(PROBE_ERROR_CODE.SOURCE_LOOKUP_FAILED);
    }
    return rows[0]?.owner_user_id ?? null;
  }

  return {
    group,

    async guardFor(raw) {
      const address = lower(raw);
      const { providerCheck } = await group();
      const owner = await ownerOf(address);
      // readableMailboxes answers null or one of the two provider reasons; anything else fails closed.
      const answer = providerCheck(address);
      const providerReason: ProviderRefusalReason | null =
        answer === null ? null : answer === 'not_in_provider_group' ? 'not_in_provider_group' : 'mirror_unavailable';
      try {
        await assertMailboxAllowed(tenantId, address, {
          purpose: MAILBOX_GUARD_PURPOSE.PROVIDER_READ,
          caller: PROBE_GUARD_CALLER,
          owner: { userId: owner },
          provider: MAILBOX_PROVIDER.GOOGLE,
          providerReason,
        });
        return null;
      } catch (error) {
        if (error instanceof MailboxAccessRefusedError) return error.reason;
        // "mailbox guard unavailable: <database message>": the code only.
        throw new ProbeCodeError(PROBE_ERROR_CODE.GUARD_UNAVAILABLE);
      }
    },

    async registeredOutOfScope(raw) {
      const address = lower(raw);
      try {
        const users = await rowsWithAddress(db.from(TABLE.USERS).select('email').ilike('email', address), 'email', address);
        if (users.length > 0) return false;
        const invites = await db.from(TABLE.INVITES).select('id').eq('email', address).limit(1);
        if (invites.error) throw new Error('lookup failed');
        if ((invites.data ?? []).length > 0) return false;
        const allowed = await db.from(TABLE.ALLOWED_MAILBOXES).select('address').eq('address', address).limit(1);
        if (allowed.error) throw new Error('lookup failed');
        if ((allowed.data ?? []).length > 0) return false;
        const sources = await rowsWithAddress(
          db
            .from(TABLE.CONTENT_SOURCES)
            .select('address')
            .eq('tenant_id', tenantId)
            .eq('kind', SOURCE_KIND.MAILBOX)
            .ilike('address', address),
          'address',
          address,
        );
        return sources.length === 0;
      } catch {
        throw new ProbeCodeError(PROBE_ERROR_CODE.OUT_OF_SCOPE_LOOKUP_FAILED);
      }
    },
  };
}
