// The one guard (#262). Every read of mailbox data, by the worker, an agent
// tool, search or retrieval, asks mailbox_guard_check first. The SQL function
// decides and writes the refusal's audit row; this module only throws.
// A failed RPC fails closed.

import {
  MAILBOX_REFUSAL_REASON,
  MAILBOX_REFUSAL_REASONS,
  SITE_REFUSAL_REASONS,
  SOURCE_KIND,
  type MailboxGuardPurpose,
  type MailboxProvider,
  type MailboxRefusalReason,
  type SourceKind,
  type SourceRefusalReason,
} from '@/lib/constants/discovery';
import { errorCodeOf } from '@/lib/errors/upstream';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

/**
 * Thrown for any refused source. The name stays; it also carries the site
 * reasons (R23). `no_capability` is not a database reason: a reader factory
 * refused a caller that does not hold the reader capability (no guard ran).
 */
export type AccessRefusalReason = SourceRefusalReason | 'no_capability';

export class MailboxAccessRefusedError extends Error {
  override readonly name = 'MailboxAccessRefusedError';
  constructor(
    readonly tenantId: string,
    readonly address: string,
    readonly reason: AccessRefusalReason,
    readonly purpose: MailboxGuardPurpose,
  ) {
    super(`Mailbox access refused (${reason}) for ${purpose}`);
  }
}

export type ProviderRefusalReason = Extract<MailboxRefusalReason, 'not_in_provider_group' | 'mirror_unavailable'>;
/** The only refusals a provider check may return (the SQL raises 22023 for any other). */
export const PROVIDER_REFUSAL_REASONS: readonly ProviderRefusalReason[] = [
  MAILBOX_REFUSAL_REASON.NOT_IN_PROVIDER_GROUP,
  MAILBOX_REFUSAL_REASON.MIRROR_UNAVAILABLE,
];

export type MailboxGuardContext = {
  // There is no `db`: the guard function is executable by service_role only, so
  // the guard builds its own service client (never one a caller hands in, whose
  // rpc could answer "allowed").
  purpose: MailboxGuardPurpose;
  /** audit_log.service_identity of a refusal, e.g. 'discovery-worker' or 'agent-tool:<name>'. */
  caller: string;
  /** The allowlisted owner must be this user (R4). A null owner refuses. Always checked. */
  owner: { userId: string | null };
  /**
   * The provider the caller reads through (round 2, item 6): a reader's own
   * provider, or, for a tool, the source's. The SQL function refuses
   * `provider_mismatch` when it is not the source's content_sources.provider.
   */
  provider: MailboxProvider;
  /** Set by the worker when the provider group excludes the address (Phase 4). */
  providerReason?: ProviderRefusalReason | null;
};

export async function assertMailboxAllowed(
  tenantId: string,
  address: string,
  ctx: MailboxGuardContext,
): Promise<void> {
  const { data, error } = await createSupabaseAdminClient().rpc('mailbox_guard_check', {
    p_tenant_id: tenantId,
    p_address: address,
    p_purpose: ctx.purpose,
    p_caller: ctx.caller,
    // Always bound: the SQL function refuses a tool, search, retrieval or export
    // call without it, and a missing owner here reads as a null owner (refused).
    p_check_owner: true,
    p_owner_user_id: ctx.owner?.userId ?? null,
    p_provider_reason: ctx.providerReason ?? null,
    p_provider: ctx.provider,
  });
  if (error) throw new Error(`mailbox guard unavailable (${errorCodeOf(error)})`);
  if (data === null) return;
  const reason = MAILBOX_REFUSAL_REASONS.find((r) => r === data);
  if (!reason) throw new Error('mailbox guard returned an unknown reason');
  throw new MailboxAccessRefusedError(tenantId, address, reason, ctx.purpose);
}

/**
 * The guard's decision for a mailbox read, without recording it (#275): mailbox_guard_verdict, the read-only half of
 * mailbox_guard_check, asked with the arguments the check passes it (the owner always bound). It writes no state and
 * no audit row. For a reader that must know the database allows a read before it makes a provider request whose
 * outcome becomes the check's provider reason; the read itself still goes through assertMailboxAllowed, which decides
 * again and records. A failed RPC or an unknown answer throws (fail closed).
 */
export async function mailboxGuardVerdict(
  tenantId: string,
  address: string,
  ctx: { provider: MailboxProvider; owner: { userId: string | null } },
): Promise<MailboxRefusalReason | null> {
  const { data, error } = await createSupabaseAdminClient().rpc('mailbox_guard_verdict', {
    p_tenant_id: tenantId,
    p_address: address,
    p_provider: ctx.provider,
    p_check_owner: true,
    p_owner_user_id: ctx.owner.userId,
  });
  if (error) throw new Error(`mailbox guard unavailable (${errorCodeOf(error)})`);
  if (data === null) return null;
  const reason = MAILBOX_REFUSAL_REASONS.find((r) => r === data);
  if (!reason) throw new Error('mailbox guard returned an unknown reason');
  return reason;
}

export type GuardedSource = { kind: SourceKind; address: string; ownerUserId: string | null };

/** What assertSourceAllowed takes: a site has no provider group or provider, so `provider` is required for a mailbox only. */
export type SourceGuardContext = Omit<MailboxGuardContext, 'owner' | 'provider'> & { provider?: MailboxProvider };

/**
 * The one entry point for a source read (R23). A mailbox gets the mailbox
 * guard with its owner bound and the provider reason; a SharePoint site gets
 * the site guard (registered by the firm's admin; no owner, no provider group).
 */
export async function assertSourceAllowed(
  tenantId: string,
  source: GuardedSource,
  ctx: SourceGuardContext,
): Promise<void> {
  if (source.kind === SOURCE_KIND.MAILBOX) {
    if (!ctx.provider) throw new Error('a mailbox guard call needs the provider it reads through');
    return assertMailboxAllowed(tenantId, source.address, {
      ...ctx,
      provider: ctx.provider,
      owner: { userId: source.ownerUserId },
    });
  }
  if (source.kind === SOURCE_KIND.SHAREPOINT_SITE) {
    const { data, error } = await createSupabaseAdminClient().rpc('site_guard_check', {
      p_tenant_id: tenantId,
      p_address: source.address,
      p_purpose: ctx.purpose,
      p_caller: ctx.caller,
    });
    if (error) throw new Error(`site guard unavailable (${errorCodeOf(error)})`);
    if (data === null) return;
    const reason = SITE_REFUSAL_REASONS.find((r) => r === data);
    if (!reason) throw new Error('site guard returned an unknown reason');
    throw new MailboxAccessRefusedError(tenantId, source.address, reason, ctx.purpose);
  }
  throw new Error(`No access guard exists for ${String(source.kind)} sources`);
}
