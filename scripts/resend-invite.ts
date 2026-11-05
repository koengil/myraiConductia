/**
 * Re-deliver a pending invitation through the product's own API.
 *
 *   APP_URL=https://app.conductia.com \
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   INVITE_ID=<uuid> \
 *   node --env-file=.env.<target> --import tsx scripts/resend-invite.ts
 *
 * The recovery path for an invitation whose credential pair went out wrong —
 * most commonly because the hosted Supabase project's Site URL / redirect
 * allowlist did not cover the deployment origin, so GoTrue silently rewrote
 * redirect_to and stranded the invitee (see
 * docs/04-operations/production-bootstrap.md). FIX THE PROJECT SETTING FIRST:
 * a resend regenerates the link against the same rejected allowlist and
 * reproduces the identical broken URL.
 *
 * POST /invites/{id}/resend rotates the credential nonce, so the previously
 * delivered pair stops being able to accept. The invitee receives two fresh
 * emails: the six-digit challenge first, then the link. Only a PENDING invite
 * can be resent (409 otherwise). Never prints passwords or tokens.
 */
import { requiredEnv, sessionCookie, signIn, signOut } from './lib/apiSession';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const appUrl = requiredEnv('APP_URL').replace(/\/$/, '');
  const supabaseUrl = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const publishableKey = requiredEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const inviteId = requiredEnv('INVITE_ID');
  if (!UUID.test(inviteId)) throw new Error('INVITE_ID must be a UUID');

  // node --env-file does NOT override a variable already exported in the
  // shell, so name the target before acting on it.
  const ref = new URL(supabaseUrl).hostname.split('.')[0];
  console.log(`Target: ${appUrl} (supabase ${ref}) — resend invite ${inviteId}`);

  const grant = await signIn(supabaseUrl, publishableKey);
  const cookie = sessionCookie(supabaseUrl, grant);

  // redirect: 'error' — a cross-origin redirect (apex to www, http to https)
  // strips the cookie header and would surface as a misleading 401.
  const res = await fetch(`${appUrl}/api/v1/invites/${inviteId}/resend`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', cookie },
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  await signOut(supabaseUrl, publishableKey, grant);

  if (!res.ok) {
    const hint =
      res.status === 404
        ? ' (unknown invite, or the platform_onboarding flag is off on this deployment)'
        : res.status === 409
          ? ' (only a pending invite can be resent — this one is accepted, revoked or expired)'
          : '';
    throw new Error(`Resend failed (${res.status})${hint}: ${JSON.stringify(body)}`);
  }

  console.log(`Resend OK (${res.status}):`, JSON.stringify(body, null, 2));
  if (body?.deliveryStatus !== 'sent') {
    console.log('Delivery did NOT complete: the invite stays pending and can be resent again.');
    return;
  }
  console.log('Two emails are on their way: the six-digit code first, then the link.');
  console.log('Any previously delivered link/code pair can no longer accept.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
