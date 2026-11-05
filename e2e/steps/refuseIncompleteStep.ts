import { expect } from '@playwright/test';
import { validateManualWork } from '@/lib/rail/manualStepDefs';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MANUAL_STEP, manualDef } from './manualStepTarget';
import type { Step } from './types';

export const refuseIncompleteStep: Step = {
  name: 'refuseIncompleteStep',

  async act(ctx) {
    await ctx.page.getByRole('button', { name: 'Mark step complete' }).click();
  },

  async assertUi(ctx) {
    const expected = validateManualWork(manualDef(MANUAL_STEP.id), {});
    expect(expected, `${MANUAL_STEP.id} declares no required field`).toBeTruthy();
    const focus = ctx.page.getByRole('region', { name: 'Step detail' });
    await expect(focus.getByRole('alert')).toHaveText(expected as string);
    await expect(ctx.page.getByRole('button', { name: 'Mark step complete' })).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { step } = await ctx.evidence.getStep(ref, MANUAL_STEP.id);
    expect(step.status, 'the refused step was completed anyway').not.toBe('complete');
    expect(step.completedAt).toBeNull();

    await expectSingleComplianceInstrument(ctx.page);
  },
};
