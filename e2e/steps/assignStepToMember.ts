import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { assignStepFromDetail, MEMBER_STEP_ID, openStepFromBoard } from '../support/rail';
import type { Step } from './types';

/**
 * The MD opens a manual step from the board and hands it to the seated member.
 * Assignment is owner only: "Assign…" renders behind `permissions.canAssign`,
 * which for an internal user is the deal MD alone, and opens the confirm
 * dialog that names who gets notified.
 */
export const assignStepToMember: Step = {
  name: 'assignStepToMember',

  async act(ctx) {
    const panel = await openStepFromBoard(
      ctx.page,
      ctx.state.dealCode as string,
      MEMBER_STEP_ID,
    );
    await assignStepFromDetail(ctx.page, panel, ctx.state.memberName as string);
  },

  async assertUi(ctx) {
    const panel = ctx.page.getByRole('region', { name: 'Manual step work' });
    await expect(
      panel.getByText(`Assigned to ${ctx.state.memberName}`),
    ).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;

    const detail = await ctx.evidence.getStep(ref, MEMBER_STEP_ID);
    expect(detail.step.assignedTo).toBe(ctx.state.memberId);
    expect(detail.step.assignedToName).toBe(ctx.state.memberName);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectStepAudit(ref, {
      action: 'assign_step',
      stepId: MEMBER_STEP_ID,
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
