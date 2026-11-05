import { expect } from '@playwright/test';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * Mirrors CLOSED_STATUS_MESSAGES.revoked in src/app/accept-invite/page.client.tsx.
 * The invitee is told the invitation was withdrawn and who to ask, and is never
 * told why, so the two strings must move together.
 */
const REVOKED_DEAD_END =
  'This invitation was revoked. Ask the person who invited you if that was a mistake.';

export const assertRevokedInviteDeadEnds: Step = {
  name: 'assertRevokedInviteDeadEnds',

  async act(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertRevokedInviteDeadEnds');
    await page.goto('/accept-invite');
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertRevokedInviteDeadEnds');
    await expect(page.getByRole('status')).toHaveText(REVOKED_DEAD_END);
    await expect(page.getByLabel('Verification code')).toHaveCount(0);
    await expect(page.getByLabel('Your name')).toHaveCount(0);
  },

  async verify(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertRevokedInviteDeadEnds');
    const response = await page.request.get('/api/v1/invites/context');
    expect(response.status()).toBe(200);
    const context = (await response.json()) as { status: string };
    expect(context.status).toBe('revoked');

    const adminEvidence = requireEvidence(ctx.adminEvidence, 'assertRevokedInviteDeadEnds');
    const invites = await adminEvidence.request.get(
      `/api/v1/invites?dealId=${encodeURIComponent(ctx.state.dealCode as string)}`,
    );
    expect(invites.status()).toBe(200);
    const pending = ((await invites.json()) as {
      invites: Array<{ email: string; status: string }>;
    }).invites.filter(
      (invite) => invite.email === ctx.state.directorEmail && invite.status === 'pending',
    );
    expect(pending, 'a revoked invitation is still pending').toHaveLength(0);
  },
};
