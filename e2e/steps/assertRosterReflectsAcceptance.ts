import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { INVITEE_DISPLAY_NAME } from './acceptInvite';
import type { Step } from './types';

/**
 * Step 8 — close the loop on the MD's own screen. The pending row the MD saw
 * in step 3 is now a seated member, and the deal's audit trail carries both
 * halves of the transaction.
 */
export const assertRosterReflectsAcceptance: Step = {
  name: 'assertRosterReflectsAcceptance',

  async act(ctx) {
    await ctx.page.goto(`/projects/${ctx.state.dealCode}/team`);
  },

  async assertUi(ctx) {
    const roster = ctx.page.getByRole('region', { name: 'Team roster' });
    await expect(roster).toBeVisible();

    // The seated member row: a button carrying the name and the email.
    const seat = roster.getByRole('button', {
      name: new RegExp(INVITEE_DISPLAY_NAME),
    });
    await expect(seat).toBeVisible();
    await expect(seat).toContainText(ctx.state.directorEmail as string);
    // Their detail opens under the row and says they have joined.
    await seat.click();
    await expect(seat).toHaveAttribute('aria-expanded', 'true');
    await expect(roster.getByText('Joined', { exact: true })).toBeVisible();

    // And the pending row is gone: no "Invite pending" line for that address.
    await expect(
      roster
        .getByRole('listitem')
        .filter({ hasText: ctx.state.directorEmail as string })
        .filter({ hasText: 'Invite pending' }),
    ).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { members } = await ctx.evidence.getDeal(ref);
    const seat = members.find(
      (member) => member.user?.email === ctx.state.directorEmail,
    );
    expect(
      seat,
      `the invitee is not a member of ${ref}; saw: ${members
        .map((member) => member.user?.email ?? '(none)')
        .join(', ')}`,
    ).toBeTruthy();
    expect(seat?.deal_role).toBe('seller');

    await ctx.evidence.expectAudit(ref, { action: 'invite_accepted', since: ctx.since });
    await ctx.evidence.expectAudit(ref, { action: 'grant', since: ctx.since });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
