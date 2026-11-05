import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import {
  CATEGORY,
  FEE,
  FEE_SHOWN,
  SCHEDULE,
  TARGET_CLOSE,
  TARGET_CLOSE_SHOWN,
} from './setBookFields';
import type { Step } from './types';

/**
 * Step 5 — the four fields survive a full page reload. The previous step
 * proved the write; this one proves the read, from a browser that kept no
 * client state of its own.
 */
export const assertBookFieldsPersist: Step = {
  name: 'assertBookFieldsPersist',

  async act(ctx) {
    await ctx.page.reload();
  },

  async assertUi(ctx) {
    const page = ctx.page;
    await expect(page.getByText(`Target close: ${TARGET_CLOSE_SHOWN}`)).toBeVisible();
    await expect(page.getByText(`Fee: ${FEE_SHOWN}`)).toBeVisible();
    await expect(page.getByText(`Schedule: ${SCHEDULE}`)).toBeVisible();
    await expect(page.getByText(`Category: ${CATEGORY}`)).toBeVisible();
    await expect(page.getByText('Saved.')).toHaveCount(0);
  },

  async verify(ctx) {
    const { deal } = await ctx.evidence.getDeal(ctx.state.dealCode as string);
    expect(deal.targetCloseDate).toBe(TARGET_CLOSE);
    expect(deal.feeUsd).toBe(Number(FEE));
    expect(deal.scheduleStatus).toBe('late');
    expect(deal.lifecycleCategory).toBe('mandate_hold');

    await expectSingleComplianceInstrument(ctx.page);
  },
};
