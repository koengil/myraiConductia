import { expect } from '@playwright/test';
import { openStepByDeepLink, zoomIntoCurrentStep } from '../support/rail';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { SKIP_STEP, STEP_AFTER_SKIP } from './manualStepTarget';
import type { Step } from './types';

export const skipStepAtCursor: Step = {
  name: 'skipStepAtCursor',

  async act(ctx) {
    const ref = ctx.state.dealCode as string;
    ctx.state.skippedStepTitle = SKIP_STEP.title;
    ctx.state.skipReason = `E2E skip reason ${ctx.runId}`;

    await ctx.page.goto(`/projects/${encodeURIComponent(ref)}/rail`);

    const focus = await zoomIntoCurrentStep(ctx.page);
    await expect(focus.getByRole('heading', { name: SKIP_STEP.title })).toBeVisible();
    await focus.getByRole('button', { name: 'Skip…' }).click();

    const dialog = ctx.page.getByRole('dialog', { name: `Skip ${SKIP_STEP.title}` });
    await expect(dialog).toBeVisible();

    const approvers = dialog.getByLabel('Approved by');
    await expect(
      approvers,
      'the skip dialog rendered no approver select; the roster is empty, still loading, or failed',
    ).toBeVisible();
    const options = await approvers.getByRole('option').allTextContents();
    const chosen = options[0];
    expect(chosen, 'the approver roster is empty, so no skip can be attributed').toBeTruthy();
    await approvers.selectOption({ label: chosen });
    ctx.state.skipApprover = chosen.split(' · ')[0];

    await dialog.getByLabel('Reason').fill(ctx.state.skipReason);
    await dialog.getByRole('button', { name: 'Skip step' }).click();
  },

  async assertUi(ctx) {
    await expect(
      ctx.page.getByRole('dialog', { name: `Skip ${SKIP_STEP.title}` }),
    ).toHaveCount(0);

    // The skip leaves the zoom on the skipped step, so its ?step= is the URL
    // already showing: the deep link has to arrive as a new entry.
    const detail = await openStepByDeepLink(
      ctx.page,
      ctx.state.dealCode as string,
      SKIP_STEP.seq,
      SKIP_STEP.title,
    );

    const runLog = detail.getByRole('region', { name: 'Run log' });
    await expect(runLog).toContainText(`approved by ${ctx.state.skipApprover}`);
    await expect(runLog).toContainText(ctx.state.skipReason as string);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;

    await expect
      .poll(async () => (await ctx.evidence.getDeal(ref)).deal.current_step_seq, {
        message: 'the skip never moved the rail cursor on the server',
      })
      .toBe(STEP_AFTER_SKIP.seq);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'advance',
      actorId: me.user.id,
      since: ctx.since,
    });

    // The skip is on the deal record, not only in this browser (bug bash
    // Finding 5): the step closed as skipped, with the reason on the row.
    const { step } = await ctx.evidence.getStep(ref, SKIP_STEP.id);
    expect(step.status, 'the skipped step is not closed on the server').toBe('skipped');
    expect(step.completionNote, 'the skip reason is not on the step record').toBe(
      ctx.state.skipReason,
    );

    await expectSingleComplianceInstrument(ctx.page);
  },
};
