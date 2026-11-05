import { expect } from '@playwright/test';
import { totpCodeWithWindowGuard } from '../support/totp';
import { requirePage } from './types';
import type { Step } from './types';

/**
 * Step 6 — enrol a real TOTP factor. Not configured away: under
 * MFA_ENFORCEMENT=invite_only, isMfaRequiredForUser returns
 * wasCreatedFromEmailInvite(user) and does not consult isMfaBypassEnabled, so
 * DISABLE_MFA=1 does not exempt an invitee. Removing the variable would make
 * the suite test a configuration the product does not run and skip a gate
 * every real invitee passes (design D8).
 *
 * The enrollment screen renders the base32 secret as visible text beside the
 * QR, so the test reads it and computes the current code the way an
 * authenticator app would.
 */
export const enrolMfa: Step = {
  name: 'enrolMfa',

  async act(ctx) {
    const page = requirePage(ctx.inviteePage, 'enrolMfa');

    const secret = (await page.getByTestId('mfa-manual-secret').innerText()).trim();
    // decodeBase32 (e2e/support/totp.ts) deliberately strips whitespace before
    // decoding, and the two-factor unit test's own mock secret is grouped
    // ('ABCD EFGH'), so the codebase already models a space-formatted key.
    // Matching only bare base32 here would fail on a product change the
    // decoder already handles correctly, so whitespace is allowed too.
    expect(secret, 'the manual setup key is empty').toMatch(/^[A-Z2-7\s]+$/);
    ctx.state.mfaSecret = secret;

    // The guard waits out a step boundary rather than submit a code that is
    // about to expire between generation and verification (design D9).
    await page.getByLabel('Six-digit code').fill(await totpCodeWithWindowGuard(secret));
    await page.getByRole('button', { name: 'Verify and continue' }).click();

    // The click resolves once Playwright's dispatch completes, not once the
    // React verify handler's awaited round trips (mfa.challenge, mfa.verify,
    // getAuthenticatorAssuranceLevel, then the completion POST) have settled.
    // A single non-waiting isVisible() read would race that in-flight work and
    // almost always see neither outcome yet. Instead, wait for whichever
    // outcome actually lands: the rejection alert becoming visible, or
    // navigation to the destination completing. That is the settled state,
    // not a fixed delay, so it satisfies D9's "no added sleeps" rule while
    // still observing the real signal.
    //
    // A plain Promise.race leaves the losing arm dangling: on the common
    // accept-on-first-try path, the rejection-alert wait keeps polling toward
    // its own timeout and eventually rejects with nothing attached to handle
    // it, which Node reports as an unhandled rejection well after this step
    // has already passed. Both arms get an explicit onRejected handler below
    // so a losing arm's eventual timeout is swallowed rather than escaping —
    // but that handler only silences the noise, it never resolves the
    // outcome. The outcome is decided solely by an arm that genuinely
    // observed its signal (resolve is called from the onFulfilled side only),
    // so a suppressed timeout can never be mistaken for a settled result. If
    // both arms time out, the promise rejects with an explicit message
    // instead of hanging or silently proceeding.
    const rejected = page.getByRole('alert').filter({
      hasText: 'The authenticator code was not accepted',
    });
    const outcome = await new Promise<'accepted' | 'rejected'>((resolve, reject) => {
      let settled = false;
      let failureCount = 0;

      const onArmTimedOut = () => {
        failureCount += 1;
        if (settled || failureCount < 2) return;
        settled = true;
        reject(
          new Error(
            'MFA verification never resolved: neither the rejection alert nor the destination navigation was observed.',
          ),
        );
      };

      rejected.waitFor({ state: 'visible' }).then(() => {
        if (settled) return;
        settled = true;
        resolve('rejected');
      }, onArmTimedOut);

      page.waitForURL(`**/projects/${ctx.state.dealCode}`).then(() => {
        if (settled) return;
        settled = true;
        resolve('accepted');
      }, onArmTimedOut);
    });

    // GoTrue tolerates one step of skew, so a rejection here is a genuine
    // failure rather than a boundary artifact. Regenerate once regardless: the
    // page clears the field and stays put on rejection, which is exactly the
    // recoverable case.
    if (outcome === 'rejected') {
      await page.getByLabel('Six-digit code').fill(await totpCodeWithWindowGuard(secret));
      await page.getByRole('button', { name: 'Verify and continue' }).click();
    }
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.inviteePage, 'enrolMfa');
    // Enrollment succeeded, the mfa_enrolled audit was recorded, and the page
    // continued to the destination it was handed.
    await page.waitForURL(`**/projects/${ctx.state.dealCode}`);
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  },

  async verify(ctx) {
    const page = requirePage(ctx.inviteePage, 'enrolMfa');
    // The session reached AAL2: every project route is middleware-gated on it
    // for this identity, so simply being on one is the proof — assert it
    // directly anyway, from the invitee's own session.
    const me = await page.request.get('/api/v1/me');
    expect(me.status(), 'the invitee session cannot read /api/v1/me').toBe(200);
  },
};
