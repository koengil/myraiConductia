import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MANUAL_STEP, SKIP_STEP, STEP_AFTER_SKIP } from './manualStepTarget';
import type { Step } from './types';

export const assertInMotionNamesNextStep: Step = {
  name: 'assertInMotionNamesNextStep',

  async act(ctx) {
    await ctx.page.goto('/projects');
  },

  async assertUi(ctx) {
    const codename = `Project E2E ${ctx.runId}`;

    await expect(
      ctx.page.getByRole('link', { name: `Open ${codename}: ${STEP_AFTER_SKIP.title}` }),
    ).toBeVisible();

    for (const behind of [MANUAL_STEP, SKIP_STEP]) {
      await expect(
        ctx.page.getByRole('link', { name: `Open ${codename}: ${behind.title}` }),
      ).toHaveCount(0);
    }
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal } = await ctx.evidence.getDeal(ref);
    expect(deal.current_step_seq).toBe(STEP_AFTER_SKIP.seq);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
