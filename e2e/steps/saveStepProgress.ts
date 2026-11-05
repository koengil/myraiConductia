import { expect, type Locator } from '@playwright/test';
import type { ManualFieldDef } from '@/lib/rail/manualStepDefs';
import { zoomIntoCurrentStep } from '../support/rail';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MANUAL_STEP, manualDef } from './manualStepTarget';
import type { Step } from './types';

const DEF = manualDef(MANUAL_STEP.id);

async function fillField(checklist: Locator, field: ManualFieldDef, value: string) {
  // Label matching stays inexact: a wrapping <label> carries the control's own
  // text too (a select's options, a textarea's rendered value), so an exact
  // match stops resolving the moment a field holds anything.
  const control = checklist.getByLabel(field.label);
  if (field.type === 'checkbox') {
    await control.check();
    return;
  }
  if (field.type === 'select') {
    // Select by value, not index: the untouched select now leads with a
    // disabled "Select…" placeholder, so indices no longer map to options.
    await control.selectOption(field.options?.[1] ?? field.options?.[0] ?? '');
    return;
  }
  await control.fill(value);
}

export const saveStepProgress: Step = {
  name: 'saveStepProgress',

  async act(ctx) {
    ctx.state.manualStepWork = `E2E checklist ${ctx.runId}`;

    const checklist = ctx.page.getByRole('group', { name: 'Manual checklist' });
    for (const field of DEF.fields) {
      await fillField(checklist, field, ctx.state.manualStepWork);
    }

    await ctx.page.getByRole('button', { name: 'Save progress' }).click();
  },

  async assertUi(ctx) {
    await ctx.page.reload();

    // The rail reopens on its board after a reload; the manual step is the
    // deal's current step, so zoom back into it and read what was saved.
    const focus = await zoomIntoCurrentStep(ctx.page);
    await expect(focus.getByRole('heading', { name: MANUAL_STEP.title })).toBeVisible();
    const checklist = focus.getByRole('group', { name: 'Manual checklist' });
    for (const field of DEF.fields) {
      const control = checklist.getByLabel(field.label);
      if (field.type === 'checkbox') {
        await expect(control).toBeChecked();
      } else if (field.type !== 'select') {
        await expect(control).toHaveValue(ctx.state.manualStepWork as string);
      }
    }
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { step } = await ctx.evidence.getStep(ref, MANUAL_STEP.id);

    for (const field of DEF.fields) {
      if (field.type === 'checkbox') {
        expect(step.work[field.id], `${field.id} did not persist`).toBe(true);
      } else if (field.type !== 'select') {
        expect(step.work[field.id], `${field.id} did not persist`).toBe(
          ctx.state.manualStepWork,
        );
      } else {
        expect(typeof step.work[field.id], `${field.id} did not persist`).toBe('string');
      }
    }

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'step_work',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
