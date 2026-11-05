import { expect } from '@playwright/test';
import { expectInvite } from '../support/invites';
import { pendingInviteRow } from '../support/selectors';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

export const revokeInvite: Step = {
  name: 'revokeInvite',

  async act(ctx) {
    const page = requirePage(ctx.adminPage, 'revokeInvite');
    const email = ctx.state.directorEmail as string;

    await page.goto(`/projects/${ctx.state.dealCode}/team`);
    const row = pendingInviteRow(page, email);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Revoke' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.adminPage, 'revokeInvite');
    await expect(
      page.getByText(ctx.state.directorEmail as string, { exact: true }),
    ).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { request } = requireEvidence(ctx.adminEvidence, 'revokeInvite');

    const invite = await expectInvite(request, ref, ctx.state.directorEmail as string, {
      status: 'revoked',
    });
    expect(invite.id).toBe(ctx.state.inviteId);

    await ctx.evidence.expectAudit(ref, { action: 'invite_revoked', since: ctx.since });
  },
};
