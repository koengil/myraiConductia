import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { UNASSIGNED_STEP_ID, openStepFromBoard } from '../support/rail';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * By design, and pinned here so the distinction cannot quietly move: on an
 * UNASSIGNED step a bank member may save work, because nobody owns it yet, but
 * may not complete it — completion stays with the MD or the assignee
 * (`resolveDealStepCapabilities`).
 */
export const memberSavesUnassignedStep: Step = {
  name: 'memberSavesUnassignedStep',

  async act(ctx) {
    const page = requirePage(ctx.memberPage, 'memberSavesUnassignedStep');
    const panel = await openStepFromBoard(
      page,
      ctx.state.dealCode as string,
      UNASSIGNED_STEP_ID,
    );

    await panel.getByLabel('NDA drafted from firm precedent').check();
    await panel.getByRole('button', { name: 'Save progress' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.memberPage, 'memberSavesUnassignedStep');
    const panel = page.getByRole('region', { name: 'Manual step work' });

    await expect(panel.getByText('Assigned to')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Save progress' })).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'Mark step complete' })).toBeDisabled();
    await expect(panel.getByRole('alert')).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const memberEvidence = requireEvidence(ctx.memberEvidence, 'memberSavesUnassignedStep');

    const detail = await memberEvidence.getStep(ref, UNASSIGNED_STEP_ID);
    expect(detail.step.assignedTo).toBeNull();
    expect(detail.permissions.canEditWork).toBe(true);
    expect(detail.permissions.canComplete).toBe(false);
    expect(detail.step.work.nda_drafted).toBe(true);
    expect(detail.step.status).not.toBe('complete');

    const forced = await memberEvidence.request.patch(
      `/api/v1/deals/${encodeURIComponent(ref)}/steps/${UNASSIGNED_STEP_ID}`,
      { data: { complete: true } },
    );
    expect(forced.status()).toBe(403);
    expect((await forced.json()).error).toBe('Not permitted to complete this step');

    await ctx.evidence.expectStepAudit(ref, {
      action: 'step_work',
      stepId: UNASSIGNED_STEP_ID,
      actorId: ctx.state.memberId,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(
      requirePage(ctx.memberPage, 'memberSavesUnassignedStep'),
    );
  },
};
