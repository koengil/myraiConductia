import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { CATEGORY, FEE_SHOWN, SCHEDULE, TARGET_CLOSE_SHOWN } from './setBookFields';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

const MD_ONLY = 'Only the deal MD can set the Book fields';

/**
 * Step 8 — a bank member on the same deal reads the Book fields and cannot
 * touch them. Nothing editable renders, and the API refuses the write even
 * when it is made without a browser: the on-screen absence and the server's
 * refusal are two different guarantees, and the product only ships the second
 * one as words.
 */
export const assertMemberBookReadOnly: Step = {
  name: 'assertMemberBookReadOnly',

  async act(ctx) {
    const page = requirePage(ctx.memberPage, 'assertMemberBookReadOnly');
    await page.goto(`/projects/${ctx.state.dealCode}/book`);
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.memberPage, 'assertMemberBookReadOnly');

    await expect(page.getByText(`Target close: ${TARGET_CLOSE_SHOWN}`)).toBeVisible();
    await expect(page.getByText(`Fee: ${FEE_SHOWN}`)).toBeVisible();
    await expect(page.getByText(`Schedule: ${SCHEDULE}`)).toBeVisible();
    await expect(page.getByText(`Category: ${CATEGORY}`)).toBeVisible();

    for (const field of [
      'Target close date',
      'Fee in US dollars',
      'Schedule status',
      'Lifecycle category',
    ]) {
      await expect(
        page.getByLabel(field, { exact: true }),
        `${field} is editable for a member`,
      ).toHaveCount(0);
    }
    await expect(page.getByRole('button', { name: /^Save / })).toHaveCount(0);
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const member = requireEvidence(ctx.memberEvidence, 'assertMemberBookReadOnly');

    // The member reads the deal — the seat is real, so the refusal below is
    // about the Book's MD-only rule and not about the perimeter.
    const { deal } = await member.getDeal(ref);
    expect(deal.lifecycleCategory).toBe('mandate_hold');

    const refused = await member.request.patch(`/api/v1/deals/${encodeURIComponent(ref)}`, {
      data: { feeUsd: 1 },
    });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { error?: string }).error).toBe(MD_ONLY);

    // The refusal wrote nothing.
    const { deal: after } = await ctx.evidence.getDeal(ref);
    expect(after.feeUsd).toBe(deal.feeUsd);

    await expectSingleComplianceInstrument(requirePage(ctx.memberPage, 'assertMemberBookReadOnly'));
  },
};
