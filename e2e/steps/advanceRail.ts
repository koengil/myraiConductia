import { expect } from '@playwright/test';
import { zoomedStepHeading, zoomIntoCurrentStep } from '../support/rail';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Step 6 — advance the deal. The durable forward movement this journey
 * asserts is the rail cursor; closing the deal is its own journey.
 */
export const advanceRail: Step = {
  name: 'advanceRail',

  async act(ctx) {
    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/rail`,
    );
    await zoomIntoCurrentStep(ctx.page);

    // The readout is the zoomed step's heading ("08 Relationship Pathing"); the
    // zoom follows the cursor, so it moves when the deal does. Capturing the actual pre-click text (rather than deriving an
    // expected string from `stepSeqBefore`) is the only way to prove movement
    // without risking a regex that never matches either before or after state.
    const readout = zoomedStepHeading(ctx.page);
    await expect(readout).toBeVisible();
    ctx.state.railReadoutBefore = (await readout.textContent()) ?? undefined;

    // Gate 0 lands the MD on Relationship Pathing (seq 8), which has no bare
    // "Move to the next step" button — it's special-work-gated (StepContract's
    // showRelationshipPathing branch). Its completion path is
    // RelationshipPathingPanel's "Approve paths", which completes the step on
    // the server; deal_step_save advances the cursor and writes the `advance`
    // audit row in the same transaction (#200), so no client /progress write
    // follows. Approving needs at least one drafted path, so
    // the honest UI route is: add a stakeholder, mark them cold (no warm
    // introducer on record), then approve.
    const pathing = ctx.page.getByRole('region', { name: 'Relationship pathing' });
    await pathing.getByRole('button', { name: 'Add stakeholder' }).click();
    await pathing.getByPlaceholder('Name').fill(`E2E Stakeholder ${ctx.runId}`);
    await pathing.getByRole('button', { name: 'Save stakeholder' }).click();

    await pathing.getByLabel('Warm path').selectOption({ label: 'Cold / no warm path' });
    await pathing.getByRole('button', { name: 'Approve paths' }).click();
  },

  async assertUi(ctx) {
    const readout = zoomedStepHeading(ctx.page);
    await expect(readout).toBeVisible();
    // A real position change: the post-click readout must differ from the
    // captured pre-click text, not merely fail to contain some derived number.
    await expect(readout).not.toHaveText(ctx.state.railReadoutBefore as string);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const before = ctx.state.stepSeqBefore as number;

    await expect
      .poll(async () => (await ctx.evidence.getDeal(ref)).deal.current_step_seq, {
        message: 'the rail advance never reached the server',
      })
      .toBeGreaterThan(before);

    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'advance',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
