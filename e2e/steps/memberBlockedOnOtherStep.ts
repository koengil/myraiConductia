import { expect } from '@playwright/test';
import { assignedElsewhereCopy } from '@/components/rail/stepActionCopy';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { assignStepFromDetail, MD_STEP_ID, openStepFromBoard } from '../support/rail';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * A step owned by somebody else. The member sees both controls disabled, and
 * the API refuses the same two acts when the button is bypassed — the disabled
 * attribute is presentation, the 403 is the rule.
 */
export const memberBlockedOnOtherStep: Step = {
  name: 'memberBlockedOnOtherStep',

  async act(ctx) {
    const dealCode = ctx.state.dealCode as string;
    const me = await ctx.evidence.me();
    ctx.state.mdName = (await ctx.evidence.getStep(dealCode, MD_STEP_ID)).members.find(
      (member) => member.id === me.user.id,
    )?.name;

    const mdPanel = await openStepFromBoard(ctx.page, dealCode, MD_STEP_ID);
    await assignStepFromDetail(ctx.page, mdPanel, ctx.state.mdName as string);
    await expect(mdPanel.getByText(`Assigned to ${ctx.state.mdName}`, { exact: true })).toBeVisible();

    await openStepFromBoard(
      requirePage(ctx.memberPage, 'memberBlockedOnOtherStep'),
      dealCode,
      MD_STEP_ID,
    );
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.memberPage, 'memberBlockedOnOtherStep');
    const panel = page.getByRole('region', { name: 'Manual step work' });

    const mdName = ctx.state.mdName as string;

    // The owner line names Storm. The disabled Save progress reason names
    // Storm too, so the owner line is matched exactly.
    await expect(panel.getByText(`Assigned to ${mdName}`, { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Assign…' })).toHaveCount(0);
    const save = panel.getByRole('button', { name: 'Save progress' });
    await expect(save).toBeDisabled();
    await expect(save).toHaveAccessibleDescription(assignedElsewhereCopy(mdName));
    await expect(panel.getByRole('button', { name: 'Mark step complete' })).toBeDisabled();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const memberEvidence = requireEvidence(ctx.memberEvidence, 'memberBlockedOnOtherStep');
    const url = `/api/v1/deals/${encodeURIComponent(ref)}/steps/${MD_STEP_ID}`;

    const work = await memberEvidence.request.patch(url, {
      data: { work: { pursue_pass_rationale: `E2E forced write ${ctx.runId}` } },
    });
    expect(work.status()).toBe(403);
    expect((await work.json()).error).toBe('Not permitted to edit step work');

    const complete = await memberEvidence.request.patch(url, { data: { complete: true } });
    expect(complete.status()).toBe(403);
    expect((await complete.json()).error).toBe('Not permitted to complete this step');

    const detail = await memberEvidence.getStep(ref, MD_STEP_ID);
    expect(detail.permissions.canEditWork).toBe(false);
    expect(detail.permissions.canComplete).toBe(false);
    expect(detail.step.status).not.toBe('complete');
    expect(detail.step.work.pursue_pass_rationale).toBeUndefined();

    await expectSingleComplianceInstrument(requirePage(ctx.memberPage, 'memberBlockedOnOtherStep'));
  },
};
