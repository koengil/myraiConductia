import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MEMBER_STEP_ID, openStepFromBoard } from '../support/rail';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

export const MEMBER_NOTES_FIELD = 'Meeting notes or transcript summary';

/**
 * The assignee's side of the assignment: the member opens the same rail, reads
 * their own name on the step, and saves work on it. "Assign…" is MD-only, so
 * the member gets the flat readout instead of a control.
 */
export const memberSavesAssignedStep: Step = {
  name: 'memberSavesAssignedStep',

  async act(ctx) {
    const page = requirePage(ctx.memberPage, 'memberSavesAssignedStep');
    const panel = await openStepFromBoard(
      page,
      ctx.state.dealCode as string,
      MEMBER_STEP_ID,
    );

    await panel.getByLabel('AI note-taking consent').selectOption('Consent granted');
    await panel.getByLabel(MEMBER_NOTES_FIELD).fill(`E2E meeting notes ${ctx.runId}`);
    await panel.getByLabel('Structured summary reviewed').check();
    await panel.getByRole('button', { name: 'Save progress' }).click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.memberPage, 'memberSavesAssignedStep');
    const panel = page.getByRole('region', { name: 'Manual step work' });

    await expect(panel.getByText(`Assigned to ${ctx.state.memberName}`)).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Assign…' }),
      'Assign… is MD-only and must not render for a member',
    ).toHaveCount(0);

    await expect(panel.getByRole('button', { name: 'Save progress' })).toBeEnabled();
    await expect(panel.getByRole('button', { name: 'Mark step complete' })).toBeEnabled();
    await expect(panel.getByRole('alert')).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const memberEvidence = requireEvidence(ctx.memberEvidence, 'memberSavesAssignedStep');

    const detail = await memberEvidence.getStep(ref, MEMBER_STEP_ID);
    expect(detail.permissions.canEditWork).toBe(true);
    expect(detail.permissions.canComplete).toBe(true);
    expect(detail.permissions.canAssign).toBe(false);
    expect(detail.step.work.meeting_notes).toBe(`E2E meeting notes ${ctx.runId}`);
    expect(detail.step.work.ai_consent).toBe('Consent granted');
    expect(detail.step.status).not.toBe('complete');

    await ctx.evidence.expectStepAudit(ref, {
      action: 'step_work',
      stepId: MEMBER_STEP_ID,
      actorId: ctx.state.memberId,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(requirePage(ctx.memberPage, 'memberSavesAssignedStep'));
  },
};
