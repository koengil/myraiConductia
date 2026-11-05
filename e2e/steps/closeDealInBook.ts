import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

export const closeDealInBook: Step = {
  name: 'closeDealInBook',

  async act(ctx) {
    const page = ctx.page;
    await page.goto(`/projects/${ctx.state.dealCode}/book`);
    const save = page.getByRole('button', { name: 'Save lifecycle category' });
    await expect(save).toBeDisabled();
    await page.getByLabel('Lifecycle category', { exact: true }).selectOption({ label: 'Closed' });
    await expect(save).toBeEnabled();
    await save.click();
  },

  async assertUi(ctx) {
    await expect(ctx.page.getByText('Saved.')).toHaveCount(1);
    await expect(ctx.page.getByText('Category: Closed')).toBeVisible();
    await expect(ctx.page.getByRole('button', { name: 'Save lifecycle category' })).toBeDisabled();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { deal } = await ctx.evidence.getDeal(ref);
    expect(deal.lifecycleCategory).toBe('closed');
    expect(deal.status).toBe('closed');

    const me = await ctx.evidence.me();
    const { events } = await ctx.evidence.listAudit(ref);
    const changes = events
      .filter((event) => event.action === 'update' && event.ts >= ctx.since)
      .filter((event) => event.actor?.id === me.user.id)
      .map((event) => event.detail);
    expect(changes).toContainEqual({ field: 'lifecycle_category', from: 'live', to: 'closed' });
    expect(changes).toContainEqual({ field: 'status', from: 'active', to: 'closed' });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
