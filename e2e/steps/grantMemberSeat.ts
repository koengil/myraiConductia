import { expect } from '@playwright/test';
import { MEMBER_EMAIL } from '../auth/session';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MEMBER_STEP_ID } from '../support/rail';
import { requireEvidence } from './types';
import type { Step } from './types';

/** scripts/seed-data.ts: the bank the seeded MD and member both belong to. */
const BANK_NAME = 'Futureproofing Capital';

/**
 * The MD seats a colleague who already holds an account. POST /api/v1/invites
 * answers 200 with `existingUser` rather than minting an invitation, so the
 * seat is granted in place — no mail, no acceptance. The seeded member's
 * address is not on the bank's verified domain, so preflight asks for the
 * domain confirmation first; the journey walks it rather than seeding around
 * it.
 */
export const grantMemberSeat: Step = {
  name: 'grantMemberSeat',

  async act(ctx) {
    ctx.state.memberEmail = MEMBER_EMAIL;

    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/team`);
    await ctx.page.getByRole('button', { name: 'Invite to deal' }).click();

    const modal = ctx.page.getByRole('dialog', { name: 'Invite to deal' });
    await expect(modal).toBeVisible();

    await modal.getByLabel('Email').fill(MEMBER_EMAIL);
    // Team invites colleagues at your own firm, so the firm is fixed.
    await expect(modal.getByLabel('Company')).toBeDisabled();
    await expect(modal.getByLabel('Company')).toContainText(BANK_NAME);
    await modal.getByLabel('Role').selectOption({ label: 'Deal Team' });

    await modal.getByRole('button', { name: 'Check and send invite' }).click();
    const confirm = modal.getByRole('button', { name: 'Confirm and send' });
    await expect(confirm).toBeVisible();
    await confirm.click();
  },

  async assertUi(ctx) {
    const modal = ctx.page.getByRole('dialog', { name: 'Invite to deal' });
    await expect(
      modal.getByText(`${MEMBER_EMAIL} already has an account and was added to this deal.`),
    ).toBeVisible();

    await modal.getByRole('button', { name: 'Done' }).click();
    // The seated colleague's row names them with their email.
    await expect(
      ctx.page.getByRole('button', { name: new RegExp(MEMBER_EMAIL.replace(/\./g, '\\.')) }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;

    const { members } = await ctx.evidence.getDeal(ref);
    const seat = members.find((member) => member.user?.email === MEMBER_EMAIL);
    expect(seat, `${MEMBER_EMAIL} holds no seat on ${ref}`).toBeTruthy();
    expect(seat?.deal_role).toBe('deal_team');
    ctx.state.memberId = seat?.user?.id;

    // Read back as the member too: the seat is only real if it is visible to
    // the identity it was granted to.
    const memberEvidence = requireEvidence(ctx.memberEvidence, 'grantMemberSeat');
    const memberMe = await memberEvidence.me();
    expect(memberMe.user.id).toBe(ctx.state.memberId);
    expect(
      memberMe.memberships.some((membership) => membership.deal_code === ref),
      'the seated member cannot see the deal on their own membership list',
    ).toBe(true);

    // The name the step panel will render, taken from the roster the step
    // endpoint itself serves rather than hardcoded from the seed.
    const detail = await ctx.evidence.getStep(ref, MEMBER_STEP_ID);
    const rosterEntry = detail.members.find((member) => member.id === ctx.state.memberId);
    expect(rosterEntry, 'the seated member is missing from the step roster').toBeTruthy();
    ctx.state.memberName = rosterEntry?.name;

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'grant',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
