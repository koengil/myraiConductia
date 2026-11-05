// The active Google registration for a tenant, and the HTTP options for one of
// its mailboxes (#259). It reads google_reader_registrations with the service
// role (the same admin client the guard builds for itself) and caches per
// tenant for a minute, so a disabled registration stops the next pass rather
// than the next process. It holds no key: a token comes from the delegated
// token cache (token.ts), scoped to gmail.readonly (plan D2).

import type { SupabaseClient } from '@supabase/supabase-js';

import { GMAIL_READER_SCOPE } from '@/lib/constants/googleReader';
import { REGISTRATION_STATUS } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import type { SourceRow } from '@/lib/discovery/source/types';
import { errorCodeOf } from '@/lib/errors/upstream';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

import type { GoogleHttpOptions } from './http';
import type { createDelegatedTokenCache, DelegationOutcome, GoogleSigningIdentity } from './token';

export type GoogleRegistration = {
  tenantId: string;
  workspaceDomain: string;
  serviceAccountEmail: string;
  clientId: string;
  directoryServiceAccountEmail: string;
  allowlistGroup: string;
  firmCompanyId: string | null;
};

export type GoogleRegistrationLookup = {
  registrationFor(tenantId: string): Promise<GoogleRegistration>;
};

export type GoogleReaderRegistry = GoogleRegistrationLookup & {
  /** The request options for one mailbox, and the client id of the registration it reads under (#370's pass record). */
  httpFor(source: SourceRow): Promise<GoogleHttpOptions & { clientId: string }>;
};

export const REGISTRATION_STALE_MS = 60_000;

/** One google_reader_registrations row, as the registry selects it. */
export type GoogleRegistrationRow = {
  tenant_id: string;
  workspace_domain: string;
  service_account_email: string;
  client_id: string;
  directory_service_account_email: string;
  allowlist_group: string;
  firm_company_id: string | null;
};

/** The columns the registry reads; the connection probe's --tenant mode reads the same (#344, R15). */
export const GOOGLE_REGISTRATION_COLUMNS =
  'tenant_id, workspace_domain, service_account_email, client_id, directory_service_account_email, allowlist_group, firm_company_id';

/** The row to registration mapping, shared by the registry and the probe, so both read one shape. */
export function googleRegistrationFromRow(row: GoogleRegistrationRow): GoogleRegistration {
  return {
    tenantId: row.tenant_id,
    workspaceDomain: row.workspace_domain,
    serviceAccountEmail: row.service_account_email,
    clientId: row.client_id,
    directoryServiceAccountEmail: row.directory_service_account_email,
    allowlistGroup: row.allowlist_group,
    firmCompanyId: row.firm_company_id,
  };
}

export function googleReaderRegistry(
  tokens?: ReturnType<typeof createDelegatedTokenCache>,
  deps: { db?: () => SupabaseClient; now?: () => number; staleMs?: number } = {},
): GoogleReaderRegistry {
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? REGISTRATION_STALE_MS;
  const cache = new Map<string, { at: number; registration: GoogleRegistration }>();

  async function registrationFor(tenantId: string): Promise<GoogleRegistration> {
    const hit = cache.get(tenantId);
    if (hit && now() - hit.at < staleMs) return hit.registration;
    const db = deps.db ? deps.db() : createSupabaseAdminClient();
    const { data, error } = await db
      .from(TABLE.GOOGLE_READER_REGISTRATIONS)
      .select(GOOGLE_REGISTRATION_COLUMNS)
      .eq('tenant_id', tenantId)
      .eq('status', REGISTRATION_STATUS.ACTIVE)
      .maybeSingle();
    if (error) throw new Error(`google registration lookup failed (${errorCodeOf(error)})`);
    if (!data) {
      cache.delete(tenantId);
      throw new Error('no active Google registration for this tenant');
    }
    const registration = googleRegistrationFromRow(data as GoogleRegistrationRow);
    cache.set(tenantId, { at: now(), registration });
    return registration;
  }

  return {
    registrationFor,
    async httpFor(source) {
      if (!tokens) throw new Error('this registry has no token cache');
      const registration = await registrationFor(source.tenantId);
      // The mint is where DWD can read any mailbox in the domain, so the
      // subject is pinned to the registered domain here as well as in the guard.
      const at = source.address.lastIndexOf('@');
      const domain = at < 0 ? '' : source.address.slice(at + 1).toLowerCase();
      if (!domain || domain !== registration.workspaceDomain.toLowerCase()) {
        throw new Error('mailbox is outside the registered Workspace domain');
      }
      return {
        getToken: tokens.forSubject(
          { tenantId: registration.tenantId, serviceAccountEmail: registration.serviceAccountEmail },
          source.address,
          GMAIL_READER_SCOPE.READONLY,
        ),
        // The DWD client id is public (Workspace's token report keys on it); the registration is already in hand.
        clientId: registration.clientId,
      };
    },
  };
}

// ── Delegation status for the admin health view (plan D11) ──────────────────

/** A status that has not changed is rewritten at most this often, so an hourly mint is not a write per mailbox. */
export const DELEGATION_RECHECK_MS = 60 * 60_000;

/**
 * The `onOutcome` hook of the delegated token cache: writes
 * google_reader_registrations.delegation_status and delegation_checked_at with
 * the service client, only when the status changes or the last check is older
 * than an hour (never a write per mint). It records a fixed status word and a
 * timestamp, nothing Google returned. A failure to record is logged without
 * detail and never reaches the read that triggered it: health is a report, not
 * a gate, and the mailbox guard is unaffected.
 */
export function googleDelegationRecorder(
  deps: { db?: () => SupabaseClient; now?: () => number } = {},
): (identity: GoogleSigningIdentity, outcome: DelegationOutcome) => Promise<void> {
  const now = deps.now ?? Date.now;
  // The last (status, time) this process wrote per tenant: a repeat inside the hour costs no round trip.
  const written = new Map<string, { status: DelegationOutcome; at: number }>();

  return async (identity, outcome) => {
    const last = written.get(identity.tenantId);
    if (last && last.status === outcome && now() - last.at < DELEGATION_RECHECK_MS) return;
    try {
      const db = deps.db ? deps.db() : createSupabaseAdminClient();
      const checkedAt = new Date(now()).toISOString();
      const staleBefore = new Date(now() - DELEGATION_RECHECK_MS).toISOString();
      // The change test runs in the database, so two workers cannot both write the same status within the hour.
      const { error } = await db
        .from(TABLE.GOOGLE_READER_REGISTRATIONS)
        .update({ delegation_status: outcome, delegation_checked_at: checkedAt })
        .eq('tenant_id', identity.tenantId)
        .or(
          `delegation_status.is.null,delegation_status.neq.${outcome},` +
            `delegation_checked_at.is.null,delegation_checked_at.lt.${staleBefore}`,
        );
      if (error) throw new Error(error.code ?? 'write failed');
      written.set(identity.tenantId, { status: outcome, at: now() });
    } catch {
      console.warn('google delegation status could not be recorded');
    }
  };
}
