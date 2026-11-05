import { expect } from '@playwright/test';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/** Satisfies the accept form's minLength={8} and scores "Strong". */
export const INVITEE_PASSWORD = 'E2e-Invitee-Passw0rd!';
export const INVITEE_DISPLAY_NAME = 'E2E External Director';

/**
 * Step 5 — the invitee accepts, in a context with NO storage state. Their
 * session comes entirely from the real path: the Supabase action link
 * redirects with tokens in the URL hash, the page exchanges them via
 * setSession, then /invites/context -> /invites/verify -> /invites/accept.
 * No second storage state is minted; the setup project is untouched.
 */
export const acceptInvite: Step = {
  name: 'acceptInvite',

  async act(ctx) {
    const page = requirePage(ctx.inviteePage, 'acceptInvite');

    await page.goto(ctx.state.inviteAcceptUrl as string);
    await page.waitForURL(/\/accept-invite/);
    // The page exchanges the hash tokens for a session asynchronously
    // (setSession, then a poll for the authenticated user) before it renders
    // the verification form. The containment probe below is only meaningful
    // once that session actually exists — wait for its first visible sign
    // rather than racing it, or an unauthenticated goto would satisfy the
    // assertion for the wrong reason (no cookie at all, not real containment).
    await expect(page.getByLabel('Verification code')).toBeVisible();

    // Containment, before anything is accepted. Two walls stand between this
    // session and the deal and the browser meets the MFA one first: middleware
    // runs before the (authed) layout, and isMfaRequiredForUser is true for an
    // invite-created identity, so an AAL1 session is bounced to /two-factor
    // rather than to /accept-invite. Both are containment; assert the property
    // that holds under either — the project route is not reachable.
    await page.goto(`/projects/${ctx.state.dealCode}`);
    await expect(page).toHaveURL(/\/(two-factor|accept-invite)/);

    // And the API layer's own wall, which is the authoritative one.
    const denied = await page.request.get(
      `/api/v1/deals/${encodeURIComponent(ctx.state.dealCode as string)}`,
    );
    expect(
      denied.status(),
      'an unaccepted invitee reached the deal API',
    ).toBe(403);

    // Back to the invitation and finish it.
    await page.goto('/accept-invite');
    await page
      .getByLabel('Verification code')
      .fill(ctx.state.inviteVerificationCode as string);
    await page.getByRole('button', { name: 'Verify code' }).click();

    await expect(page.getByLabel('Your name')).toBeVisible();
    await page.getByLabel('Your name').fill(INVITEE_DISPLAY_NAME);
    await page.getByLabel('Password', { exact: true }).fill(INVITEE_PASSWORD);
    await page.getByLabel('Confirm password', { exact: true }).fill(INVITEE_PASSWORD);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Accept invitation' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.inviteePage, 'acceptInvite');
    // Acceptance routes to the server-owned MFA gate, carrying the deal as the
    // destination. Under MFA_ENFORCEMENT=invite_only this gate is mandatory
    // for an invitee and DISABLE_MFA does not exempt them (design D8).
    await page.waitForURL(/\/two-factor/);
    expect(new URL(page.url()).searchParams.get('redirectTo')).toBe(
      `/projects/${ctx.state.dealCode}`,
    );
    await expect(
      page.getByRole('heading', { name: 'Set up two-factor authentication' }),
    ).toBeVisible();
  },

  async verify(ctx) {
    // The invitation is spent. Read as the firm admin, who can see the deal's
    // invite rows; the invitee themselves is mid-enrollment.
    const adminEvidence = requireEvidence(ctx.adminEvidence, 'acceptInvite');
    const invites = await adminEvidence.request.get(
      `/api/v1/invites?dealId=${encodeURIComponent(ctx.state.dealCode as string)}`,
    );
    expect(invites.status()).toBe(200);
    const row = ((await invites.json()) as {
      invites: Array<{ email: string; status: string }>;
    }).invites.find((invite) => invite.email === ctx.state.directorEmail);
    expect(row?.status, 'the invitation is still pending after acceptance').toBe(
      'accepted',
    );
  },
};
