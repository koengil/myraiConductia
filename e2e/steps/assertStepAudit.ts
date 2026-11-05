import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { MANUAL_STEP, SKIP_STEP, STEP_AFTER_SKIP } from './manualStepTarget';
import type { Step } from './types';

export const assertStepAudit: Step = {
  name: 'assertStepAudit',

  async act(ctx) {
    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/audit`,
    );
    await expect(ctx.page.getByRole('heading', { name: 'Audit Trail' })).toBeVisible();
  },

  async assertUi(ctx) {
    const rows = ctx.page.getByRole('listitem');

    await ctx.page.getByRole('button', { name: 'Steps' }).click();

    await expect(
      rows.filter({ hasText: 'Marked complete' }).filter({ hasText: MANUAL_STEP.title }),
    ).toHaveCount(1);

    const skipRow = rows.filter({ hasText: 'Skipped' }).filter({ hasText: SKIP_STEP.title });
    await expect(skipRow).toHaveCount(1);
    await expect(skipRow).toContainText(
      `Approved by ${ctx.state.skipApprover} · ${ctx.state.skipReason}`,
    );

    await ctx.page.getByRole('button', { name: 'Platform' }).click();

    const advanceRow = rows
      .filter({ hasText: 'Advanced the rail' })
      // Audit rows name the steps, not their numbers (S5 C-53).
      .filter({ hasText: `${SKIP_STEP.title} → ${STEP_AFTER_SKIP.title}` });
    await expect(advanceRow).toHaveCount(1);
    // The MD's own row reads "You"; verify() proves from the API that the
    // advance row's actor is the signed-in MD.
    await expect(advanceRow.getByTestId('audit-row-person')).toHaveText('You');
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const me = await ctx.evidence.me();
    const { events } = await ctx.evidence.listAudit(ref);

    const advance = events.find((event) => {
      const detail = event.detail as { from?: number; to?: number } | null;
      return (
        event.action === 'advance' &&
        event.ts >= ctx.since &&
        event.actor?.id === me.user.id &&
        detail?.from === SKIP_STEP.seq &&
        detail?.to === STEP_AFTER_SKIP.seq
      );
    });
    expect(
      advance,
      `no audited advance from ${SKIP_STEP.seq} to ${STEP_AFTER_SKIP.seq}`,
    ).toBeTruthy();

    const complete = events.find((event) => {
      const detail = event.detail as { stepId?: string } | null;
      return (
        event.action === 'complete_step' &&
        event.ts >= ctx.since &&
        event.actor?.id === me.user.id &&
        detail?.stepId === MANUAL_STEP.id
      );
    });
    expect(complete, `no audited completion of ${MANUAL_STEP.id}`).toBeTruthy();

    await expectSingleComplianceInstrument(ctx.page);
  },
};
