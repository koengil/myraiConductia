import { expect } from '@playwright/test';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * The re-issued credential works: the newest link signs the invitee in, the
 * newest code clears the challenge, and the acceptance form is reachable
 * again. Acceptance itself is the invite-onboarding journey's subject and is
 * deliberately not repeated here.
 */
export const assertReissuedLinkOpensAcceptance: Step = {
  name: 'assertReissuedLinkOpensAcceptance',

  async act(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertReissuedLinkOpensAcceptance');

    await page.goto(ctx.state.inviteAcceptUrl as string);
    await page.waitForURL(/\/accept-invite/);
    await expect(page.getByLabel('Verification code')).toBeVisible();

    await page
      .getByLabel('Verification code')
      .fill(ctx.state.inviteVerificationCode as string);
    await page.getByRole('button', { name: 'Verify code' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertReissuedLinkOpensAcceptance');
    await expect(page.getByLabel('Your name')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  },

  async verify(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertReissuedLinkOpensAcceptance');
    const response = await page.request.get('/api/v1/invites/context');
    expect(response.status()).toBe(200);
    const context = (await response.json()) as {
      status: string;
      email: string;
      verificationRequired: boolean;
      companyRole?: string;
      dealRole?: string | null;
    };
    expect(context.status).toBe('pending');
    expect(context.email).toBe(ctx.state.directorEmail);
    expect(context.verificationRequired).toBe(false);
    expect(context.companyRole).toBe('director');
    expect(context.dealRole).toBe('seller');

    const adminEvidence = requireEvidence(ctx.adminEvidence, 'assertReissuedLinkOpensAcceptance');
    const invites = await adminEvidence.request.get(
      `/api/v1/invites?dealId=${encodeURIComponent(ctx.state.dealCode as string)}`,
    );
    expect(invites.status()).toBe(200);
    const rows = ((await invites.json()) as {
      invites: Array<{ id: string; email: string; status: string }>;
    }).invites.filter((invite) => invite.email === ctx.state.directorEmail);
    expect(rows.map((row) => row.status).sort()).toEqual(['pending', 'revoked']);
  },
};
