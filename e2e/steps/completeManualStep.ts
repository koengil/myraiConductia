import { expect } from '@playwright/test';
import { openStepByDeepLink } from '../support/rail';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MANUAL_STEP, MANUAL_STEP_SEQ, SKIP_STEP } from './manualStepTarget';
import type { Step } from './types';

export const completeManualStep: Step = {
  name: 'completeManualStep',

  async act(ctx) {
    ctx.state.completedStepTitle = MANUAL_STEP.title;
    await ctx.page.getByRole('button', { name: 'Mark step complete' }).click();
  },

  // Completing jumps Focus to the next step, so the completed step's own
  // card has to be reopened to read its state back.
  async assertUi(ctx) {
    const focus = ctx.page.getByRole('region', { name: 'Step detail' });
    await expect(focus.getByRole('heading', { name: SKIP_STEP.title })).toBeVisible();

    const completed = await openStepByDeepLink(
      ctx.page,
      ctx.state.dealCode as string,
      MANUAL_STEP_SEQ,
      MANUAL_STEP.title,
    );
    await expect(completed.getByText('Complete', { exact: true })).toBeVisible();
    await expect(completed.getByRole('button', { name: 'Mark step complete' })).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const me = await ctx.evidence.me();

    const { step } = await ctx.evidence.getStep(ref, MANUAL_STEP.id);
    expect(step.status).toBe('complete');
    expect(step.completedBy).toBe(me.user.id);

    await ctx.evidence.expectAudit(ref, {
      action: 'complete_step',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expect
      .poll(async () => (await ctx.evidence.getDeal(ref)).deal.current_step_seq, {
        message: 'completing the step never moved the rail cursor on the server',
      })
      .toBe(SKIP_STEP.seq);
    expect(SKIP_STEP.seq).toBeGreaterThan(MANUAL_STEP_SEQ);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
