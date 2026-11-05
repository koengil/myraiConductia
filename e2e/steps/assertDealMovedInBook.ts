import { expect } from '@playwright/test';
import { bookTable, expectBookSectionOrder, openBookView } from '../support/book';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { CATEGORY, FEE_SHOWN, TARGET_CLOSE_SHOWN } from './setBookFields';
import type { Step } from './types';

/**
 * Step 6 — the Book home regroups. The deal left "Live deals" for the
 * category its MD chose, carrying the close date, schedule and fee he set, and
 * the sections still read in Storm's order.
 */
export const assertDealMovedInBook: Step = {
  name: 'assertDealMovedInBook',

  async act(ctx) {
    await ctx.page.goto('/projects');
    await openBookView(ctx.page);
  },

  async assertUi(ctx) {
    const codename = `Project E2E ${ctx.runId}`;
    const deal = ctx.page.getByRole('link', { name: codename, exact: true });

    const moved = bookTable(ctx.page, CATEGORY).getByRole('row').filter({ has: deal });
    await expect(moved).toHaveCount(1);
    await expect(moved).toContainText(TARGET_CLOSE_SHOWN);
    await expect(moved).toContainText('Late');
    await expect(moved).toContainText(FEE_SHOWN);

    await expect(bookTable(ctx.page, 'Live deals').getByRole('row').filter({ has: deal })).toHaveCount(0);

    const sections = await expectBookSectionOrder(ctx.page);
    expect(sections).toContain(CATEGORY);
  },

  async verify(ctx) {
    const { deal } = await ctx.evidence.getDeal(ctx.state.dealCode as string);
    expect(deal.lifecycleCategory).toBe('mandate_hold');

    await expectSingleComplianceInstrument(ctx.page);
  },
};
