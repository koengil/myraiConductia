import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MEMBER_STEP_ID, openStepFromBoard } from '../support/rail';
import { MEMBER_NOTES_FIELD } from './memberSavesAssignedStep';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

export const memberReadsCompletedStep: Step = {
  name: 'memberReadsCompletedStep',

  async act(ctx) {
    const page = requirePage(ctx.memberPage, 'memberReadsCompletedStep');
    await openStepFromBoard(page, ctx.state.dealCode as string, MEMBER_STEP_ID);
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.memberPage, 'memberReadsCompletedStep');
    const panel = page.getByRole('region', { name: 'Manual step work' });

    await expect(panel.getByLabel(MEMBER_NOTES_FIELD)).toHaveValue(
      `E2E meeting notes ${ctx.runId}`,
    );
    await expect(panel.getByLabel('Structured summary reviewed')).toBeChecked();
    await expect(panel.getByText('Complete on the deal record.')).toBeVisible();

    await expect(
      panel.getByLabel(MEMBER_NOTES_FIELD),
      'a completed step is a record, readable but not editable',
    ).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Mark step complete' })).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const memberEvidence = requireEvidence(ctx.memberEvidence, 'memberReadsCompletedStep');

    const detail = await memberEvidence.getStep(ref, MEMBER_STEP_ID);
    expect(detail.step.status).toBe('complete');
    expect(detail.step.work.meeting_notes).toBe(`E2E meeting notes ${ctx.runId}`);

    await expectSingleComplianceInstrument(
      requirePage(ctx.memberPage, 'memberReadsCompletedStep'),
    );
  },
};
