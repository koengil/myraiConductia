import { expect } from '@playwright/test';
import { bookTable, expectBookSectionOrder, openBookView } from '../support/book';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Step 3 — switch the bank home to the Book and read the freshly opened deal
 * off it. A deal nobody has priced yet carries no close date, no schedule and
 * no fee, so its row is the one place the Book's "unset shows a dash" contract
 * can be asserted honestly.
 */
export const openBookHome: Step = {
  name: 'openBookHome',

  async act(ctx) {
    await ctx.page.goto('/projects');
    await openBookView(ctx.page);
  },

  async assertUi(ctx) {
    await expect(
      ctx.page.getByRole('heading', { name: 'Your book' }),
    ).toBeVisible();

    // The header row's accessible name is its five cells in order, so one
    // assertion pins the column set AND the column order.
    const live = bookTable(ctx.page, 'Live deals');
    await expect(live.getByRole('row', { name: 'Deal Phase Target close Schedule Fee' })).toHaveCount(1);

    const row = live.getByRole('row').filter({
      has: ctx.page.getByRole('link', { name: `Project E2E ${ctx.runId}`, exact: true }),
    });
    await expect(row).toHaveCount(1);
    const cells = row.getByRole('cell');
    await expect(cells.nth(2)).toHaveText('Not set');
    await expect(cells.nth(3)).toHaveText('Not set');
    await expect(cells.nth(4)).toHaveText('Not set');

    await expectBookSectionOrder(ctx.page);
  },

  async verify(ctx) {
    const { deal } = await ctx.evidence.getDeal(ctx.state.dealCode as string);
    expect(deal.targetCloseDate).toBeNull();
    expect(deal.feeUsd).toBeNull();
    expect(deal.scheduleStatus).toBeNull();
    expect(deal.lifecycleCategory).toBe('live');

    await expectSingleComplianceInstrument(ctx.page);
  },
};
