import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MEMBER_STEP_ID, openPhaseOf, openStepFromBoard, stepLocator } from '../support/rail';
import { MEMBER_NOTES_FIELD } from './memberSavesAssignedStep';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * The member completes the step they own. Opened from the board rather than
 * continued from the previous step's panel, so the saved work is proven to
 * survive a reload before it is completed. Completion advances the rail and
 * carries the zoomed-in step to the next one, so the visible outcome is read
 * off the completed step's card on the board rather than off the panel that
 * unmounts underneath it.
 */
export const memberCompletesAssignedStep: Step = {
  name: 'memberCompletesAssignedStep',

  async act(ctx) {
    const page = requirePage(ctx.memberPage, 'memberCompletesAssignedStep');
    const panel = await openStepFromBoard(
      page,
      ctx.state.dealCode as string,
      MEMBER_STEP_ID,
    );

    await expect(panel.getByLabel(MEMBER_NOTES_FIELD)).toHaveValue(
      `E2E meeting notes ${ctx.runId}`,
    );
    const completed = page.waitForResponse(
      (response) =>
        response.url().includes(`/steps/${MEMBER_STEP_ID}`) &&
        response.request().method() === 'PATCH',
    );
    await panel.getByRole('button', { name: 'Mark step complete' }).click();
    await completed;

    await page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/rail`);
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.memberPage, 'memberCompletesAssignedStep');

    await openPhaseOf(page, MEMBER_STEP_ID);
    await expect(stepLocator(page, MEMBER_STEP_ID, 'Done')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Rail overview' }).getByRole('alert'),
    ).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const memberEvidence = requireEvidence(ctx.memberEvidence, 'memberCompletesAssignedStep');

    const detail = await memberEvidence.getStep(ref, MEMBER_STEP_ID);
    expect(detail.step.status).toBe('complete');
    expect(detail.permissions.canComplete, 'a complete step cannot be completed again').toBe(
      false,
    );

    await ctx.evidence.expectStepAudit(ref, {
      action: 'complete_step',
      stepId: MEMBER_STEP_ID,
      actorId: ctx.state.memberId,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(
      requirePage(ctx.memberPage, 'memberCompletesAssignedStep'),
    );
  },
};
