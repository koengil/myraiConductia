import { expect } from '@playwright/test';
import { zoomIntoCurrentStep } from '../support/rail';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MANUAL_STEP, MANUAL_STEP_SEQ } from './manualStepTarget';
import type { Step } from './types';

// Depends on advanceRail having moved the cursor to the live MD Briefing step
// (seq 9): its plain "Move to the next step" (PATCH /progress, the cursor
// only; handoff E28) is what carries the cursor onto the first manual step,
// which is where the Skip flow and the checklist both live.
export const advanceCursorToManualStep: Step = {
  name: 'advanceCursorToManualStep',

  async act(ctx) {
    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/rail`,
    );

    const focus = await zoomIntoCurrentStep(ctx.page);
    await focus.getByRole('button', { name: 'Move to the next step', exact: true }).click();
  },

  async assertUi(ctx) {
    const focus = ctx.page.getByRole('region', { name: 'Step detail' });
    await expect(focus.getByRole('heading', { name: MANUAL_STEP.title })).toBeVisible();
    await expect(focus.getByRole('group', { name: 'Manual checklist' })).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;

    await expect
      .poll(async () => (await ctx.evidence.getDeal(ref)).deal.current_step_seq, {
        message: 'the cursor never reached the manual step on the server',
      })
      .toBe(MANUAL_STEP_SEQ);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'advance',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
