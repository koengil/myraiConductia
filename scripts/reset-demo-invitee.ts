/**
 * Demo reset: recycle an invitee email so the invite flow can be demoed
 * fresh from the start, repeatedly.
 *
 *   INVITEE_EMAIL=martin.casado@futureproofing.dev npm run demo:reset-invitee
 *
 * What it does (and deliberately does not do):
 *  - Deletes every invites row for the email (frees the global
 *    one-pending-invite-per-email unique index).
 *  - Removes the mirror user's deal_memberships (their seats).
 *  - Tombstones the identity instead of deleting it: audit_log.actor_id
 *    references users and the audit log is immutable evidence, so the row
 *    is renamed to <local>+used-<ts>@<domain> and suspended. The auth
 *    identity gets the same tombstone email so a fresh invite mints a
 *    brand-new identity for the original address.
 *  - Never touches any other account.
 */
import { createClient } from '@supabase/supabase-js';
import { recycleInvitee } from './lib/recycleInvitee';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const email = (process.env.INVITEE_EMAIL ?? '').trim().toLowerCase();

if (!url || !secret) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (.env.local).');
if (!email) throw new Error('INVITEE_EMAIL is required.');

const admin = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const result = await recycleInvitee(admin, email);
  console.log(`invites removed: ${result.invitesRemoved}`);
  if (!result.tombstone) {
    console.log('No mirror user for that email. Fresh state — done.');
    return;
  }
  console.log(`deal seats removed: ${result.seatsRemoved}`);
  console.log(
    `identity recycled: ${email} -> ${result.tombstone} (suspended). Ready for a fresh invite.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
