import { expect } from '@playwright/test';
import { expectInvite } from '../support/invites';
import { pendingInviteRow } from '../support/selectors';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

export const resendInvite: Step = {
  name: 'resendInvite',

  async act(ctx) {
    const page = requirePage(ctx.adminPage, 'resendInvite');
    const email = ctx.state.directorEmail as string;

    await page.goto(`/projects/${ctx.state.dealCode}/team`);
    const row = pendingInviteRow(page, email);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Resend' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.adminPage, 'resendInvite');
    const row = pendingInviteRow(page, ctx.state.directorEmail as string);

    // The button re-enables when the roster has reloaded, so this is also the
    // wait for the resend to have settled.
    await expect(row.getByRole('button', { name: 'Resend' })).toBeEnabled();
    await expect(row).toContainText('Invite pending');
    await expect(row.getByRole('alert')).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { request } = requireEvidence(ctx.adminEvidence, 'resendInvite');

    const invite = await expectInvite(request, ref, ctx.state.directorEmail as string, {
      status: 'pending',
      deliveryStatus: 'sent',
    });
    expect(invite.id, 'a resend created a second invite row').toBe(ctx.state.inviteId);

    await ctx.evidence.expectAudit(ref, {
      action: 'invite_challenge_rotated',
      since: ctx.since,
    });
  },
};
