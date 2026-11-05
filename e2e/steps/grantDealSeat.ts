import { expect } from '@playwright/test';
import { MEMBER_EMAIL } from '../auth/session';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/** The seat a bank member takes on the deal (INTERNAL_ASSIGNABLE_DEAL_ROLES). */
const SEAT_LABEL = 'Deal Team';
const SEAT = 'deal_team';

/**
 * Step 7 — the MD seats a seeded bank member on the deal from Team. The
 * address already has an account, so POST /api/v1/invites grants the seat
 * directly instead of sending an invitation; the modal says so.
 *
 * The seat is the precondition the read-only assertion needs: without it the
 * member's PATCH would be refused as "Not a member of this deal", which proves
 * the perimeter rather than the Book's MD-only rule.
 */
export const grantDealSeat: Step = {
  name: 'grantDealSeat',

  async act(ctx) {
    ctx.state.memberEmail = MEMBER_EMAIL;
    const { bankCompanyId } = await ctx.evidence.listTeam(ctx.state.dealCode as string);
    expect(bankCompanyId, 'the deal names no advisory bank').toBeTruthy();

    await ctx.page.goto(`/projects/${ctx.state.dealCode}/team`);
    await ctx.page.getByRole('button', { name: 'Invite to deal' }).click();

    const modal = ctx.page.getByRole('dialog', { name: 'Invite to deal' });
    await expect(modal).toBeVisible();
    await modal.getByLabel('Email').fill(MEMBER_EMAIL);
    // Team invites colleagues at your own firm, so the firm is fixed.
    await expect(modal.getByLabel('Company')).toHaveValue(bankCompanyId as string);
    await modal.getByLabel('Role').selectOption({ label: SEAT_LABEL });

    // The seeded accounts sit on dev.com and the bank verifies
    // futureproofing.com, so preflight classifies the address a mismatch and
    // the inviter confirms before the seat is granted.
    await modal.getByRole('button', { name: 'Check and send invite' }).click();
    await modal.getByRole('button', { name: 'Confirm and send' }).click();
  },

  async assertUi(ctx) {
    const modal = ctx.page.getByRole('dialog', { name: 'Invite to deal' });
    await expect(
      modal.getByText(`${MEMBER_EMAIL} already has an account and was added to this deal.`),
    ).toBeVisible();
    await modal.getByRole('button', { name: 'Done' }).click();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { members } = await ctx.evidence.listTeam(ref);
    const seated = members.find((member) => member.email === MEMBER_EMAIL);
    expect(seated, `${MEMBER_EMAIL} holds no seat on ${ref}`).toBeTruthy();
    expect(seated?.dealRole).toBe(SEAT);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'grant',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
