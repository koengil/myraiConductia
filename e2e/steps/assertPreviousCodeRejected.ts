import { expect } from '@playwright/test';
import { expectInvite } from '../support/invites';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * The resend rotated the credential, so the previously delivered six-digit
 * challenge is spent. The invitee opens the current link and offers the old
 * code; the product must refuse it and keep them off the acceptance form.
 */
export const assertPreviousCodeRejected: Step = {
  name: 'assertPreviousCodeRejected',

  async act(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertPreviousCodeRejected');

    await page.goto(ctx.state.inviteAcceptUrl as string);
    await page.waitForURL(/\/accept-invite/);
    await expect(page.getByLabel('Verification code')).toBeVisible();

    await page
      .getByLabel('Verification code')
      .fill(ctx.state.previousInviteVerificationCode as string);
    await page.getByRole('button', { name: 'Verify code' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertPreviousCodeRejected');
    await expect(page.getByRole('status')).toContainText(
      'That verification code is not valid.',
    );
    await expect(page.getByLabel('Your name')).toHaveCount(0);
  },

  async verify(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertPreviousCodeRejected');
    const response = await page.request.get('/api/v1/invites/context');
    expect(response.status()).toBe(200);
    const context = (await response.json()) as {
      status: string;
      verificationRequired: boolean;
      locked: boolean;
    };
    expect(context.status).toBe('pending');
    expect(
      context.verificationRequired,
      'the superseded code verified the challenge',
    ).toBe(true);
    expect(context.locked).toBe(false);

    const adminEvidence = requireEvidence(ctx.adminEvidence, 'assertPreviousCodeRejected');
    await expectInvite(
      adminEvidence.request,
      ctx.state.dealCode as string,
      ctx.state.directorEmail as string,
      { status: 'pending', deliveryStatus: 'sent' },
    );
  },
};
