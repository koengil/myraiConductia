import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

export const switchDeal: Step = {
  name: 'switchDeal',

  async act(ctx) {
    await ctx.page
      .getByRole('banner')
      .getByRole('button', { name: /Switch deal|Select a deal/ })
      .click();
    await ctx.page
      .getByRole('listbox', { name: 'Deals' })
      .getByRole('option', { name: ctx.state.dealCodename as string })
      .click();
  },

  async assertUi(ctx) {
    await expect(
      ctx.page.getByRole('banner').getByRole('button', {
        name: `Deal: ${ctx.state.dealCodename as string}. Switch deal`,
      }),
    ).toBeVisible();

    await expect
      .poll(() => decodeURIComponent(new URL(ctx.page.url()).pathname.split('/')[2] ?? ''), {
        message: 'the switcher never routed to the selected deal',
      })
      .toBe(ctx.state.dealCode as string);
  },

  async verify(ctx) {
    const segment = decodeURIComponent(new URL(ctx.page.url()).pathname.split('/')[2] as string);
    const { deal } = await ctx.evidence.getDeal(segment);

    expect(deal.code).toBe(ctx.state.dealCode as string);
    expect(deal.codename).toBe(ctx.state.dealCodename as string);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
