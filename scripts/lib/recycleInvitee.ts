import type { SupabaseClient } from '@supabase/supabase-js';

export type RecycleResult = {
  invitesRemoved: number;
  seatsRemoved: number;
  /** The address the identity was renamed to, or null when none existed. */
  tombstone: string | null;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

/**
 * Identities an earlier, interrupted recycle of this address already tombstoned:
 * users named <local>+used-<ts>@<domain>, found by the accepted invitations'
 * user ids and by the tombstone pattern. Returns [] when there are none.
 */
async function tombstonedIdentities(
  admin: SupabaseClient,
  email: string,
  acceptedUserIds: string[],
): Promise<Array<{ id: string; email: string }>> {
  const [local, domain] = email.split('@');
  const shape = new RegExp(`^${escapeRegExp(local)}\\+used-\\d+@${escapeRegExp(domain)}$`);
  const found = new Map<string, string>();
  const keep = (rows: unknown) => {
    for (const row of (rows ?? []) as Array<{ id: string; email: string }>) {
      if (shape.test(row.email.toLowerCase())) found.set(row.id, row.email);
    }
  };
  if (acceptedUserIds.length > 0) {
    const { data, error } = await admin.from('users').select('id, email').in('id', acceptedUserIds);
    if (error) throw new Error(`tombstone lookup failed: ${error.message}`);
    keep(data);
  }
  const { data, error } = await admin
    .from('users')
    .select('id, email')
    .like('email', `${escapeLike(local)}+used-%@${escapeLike(domain)}`);
  if (error) throw new Error(`tombstone lookup failed: ${error.message}`);
  keep(data);
  return [...found].map(([id, tombstoned]) => ({ id, email: tombstoned }));
}

/**
 * Free an invitee address for reuse: delete its invitations, drop the mirror
 * user's seats, and TOMBSTONE the identity rather than delete it.
 *
 * Tombstoning, not deletion, because audit_log.actor_id references users and
 * the audit log is immutable evidence. The row is renamed to
 * <local>+used-<ts>@<domain> and suspended; the auth identity takes the same
 * name, so a fresh invitation for the original address mints a brand-new
 * identity. Never touches any other account.
 *
 * The identity is unseated FIRST (audit round 1, item 13). Losing the seat
 * withdraws the address's mailbox consent through the seat-loss trigger, so the
 * consent's withdrawal is audited before its invite (and, by cascade, the
 * consent row) is deleted. Deleting the invite also withdraws any consent that
 * is still open, so the audit log never shows an opt-in with no end either way.
 *
 * Resumable (C15, #262). The tombstone comes first and the seats last, so a
 * failure in between leaves an address with no live user. A retry then finds
 * the identity it already tombstoned, by the user id on the address's accepted
 * invitation while that invitation exists, and by the tombstone's own name
 * (<local>+used-<ts>@<domain>) once it is gone, and still clears the seats and
 * the invitations. Only a user whose email is exactly such a tombstone of THIS
 * address is taken, so no other account is ever touched.
 *
 * Shared by `npm run demo:reset-invitee` and the E2E teardown project, so the
 * two cannot drift (design D12).
 */
export async function recycleInvitee(
  admin: SupabaseClient,
  rawEmail: string,
): Promise<RecycleResult> {
  const email = rawEmail.trim().toLowerCase();

  // The address's invitations, read first: their accepted user ids name an identity a retry must find.
  const { data: staleInvites, error: lookupError } = await admin.from('invites').select('id, accepted_user_id').eq('email', email);
  if (lookupError) throw new Error(`invite lookup failed: ${lookupError.message}`);
  const staleIds = (staleInvites ?? []).map((row) => row.id as string);
  const acceptedUserIds = [
    ...new Set((staleInvites ?? []).map((row) => row.accepted_user_id as string | null).filter((id): id is string => !!id)),
  ];

  // Unseat and tombstone the identity before anything is deleted, so its
  // mailbox consent is withdrawn (audited) while its invite still exists.
  const { data: user, error: userError } = await admin
    .from('users')
    .select('id, status')
    .eq('email', email)
    .maybeSingle();
  if (userError) throw new Error(`user lookup failed: ${userError.message}`);
  let tombstone: string | null = null;
  // Every identity whose seats this run clears: the live user, or the ones an interrupted run tombstoned.
  const identityIds: string[] = [];
  if (user) {
    identityIds.push(user.id as string);
    const [local, domain] = email.split('@');
    tombstone = `${local}+used-${Date.now()}@${domain}`;

    const { error: authError } = await admin.auth.admin.updateUserById(user.id as string, {
      email: tombstone,
      user_metadata: { invite_id: null, credential_nonce: null },
    });
    if (authError) throw new Error(`auth tombstone failed: ${authError.message}`);

    const { error: mirrorError } = await admin
      .from('users')
      .update({ email: tombstone, status: 'suspended', company_id: null, company_role: null })
      .eq('id', user.id);
    if (mirrorError) throw new Error(`mirror tombstone failed: ${mirrorError.message}`);
  } else {
    // A retry after a partial failure: the original address has no live user because this recycle
    // already renamed it. Unseat what it left, as above, before any invitation goes.
    const prior = await tombstonedIdentities(admin, email, acceptedUserIds);
    for (const identity of prior) {
      identityIds.push(identity.id);
      tombstone = identity.email;
      const { error: unseatError } = await admin
        .from('users')
        .update({ status: 'suspended', company_id: null, company_role: null })
        .eq('id', identity.id);
      if (unseatError) throw new Error(`mirror tombstone failed: ${unseatError.message}`);
    }
  }

  // invite_domain_confirmations references consumed invites without ON DELETE;
  // clear those rows first so the invite delete can proceed.
  if (staleIds.length > 0) {
    // Administrative fixture recycling only; audit evidence is preserved.
    const { error: affiliationError } = await admin.from('deal_recipient_affiliations')
      .delete().in('invite_id', staleIds);
    if (affiliationError) throw new Error(`affiliations delete failed: ${affiliationError.message}`);
    const { error } = await admin
      .from('invite_domain_confirmations')
      .delete()
      .in('consumed_invite_id', staleIds);
    if (error) throw new Error(`confirmations delete failed: ${error.message}`);
  }

  const { error: invitesError, count } = await admin
    .from('invites')
    .delete({ count: 'exact' })
    .eq('email', email);
  if (invitesError) throw new Error(`invites delete failed: ${invitesError.message}`);

  if (identityIds.length === 0) {
    return { invitesRemoved: count ?? 0, seatsRemoved: 0, tombstone: null };
  }

  const { error: seatsError, count: seatCount } = await admin
    .from('deal_memberships')
    .delete({ count: 'exact' })
    .in('user_id', identityIds);
  if (seatsError) throw new Error(`seat delete failed: ${seatsError.message}`);

  return { invitesRemoved: count ?? 0, seatsRemoved: seatCount ?? 0, tombstone };
}
