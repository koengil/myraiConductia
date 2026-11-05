import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requirePage } from './types';
import type { Step } from './types';

export const assertOpeningRecordsNothing: Step = {
  name: 'assertOpeningRecordsNothing',

  async act(ctx) {
    const ref = ctx.state.dealCode as string;
    const { events } = await ctx.evidence.listAudit(ref);
    ctx.state.auditIdsBeforeOpen = events.map((event) => event.id);

    const external = requirePage(ctx.externalPage, 'assertOpeningRecordsNothing');
    await external.goto(`/projects/${encodeURIComponent(ref)}/data-room`);
    await ctx.page.goto(`/projects/${encodeURIComponent(ref)}/data-room`);
  },

  async assertUi(ctx) {
    const external = requirePage(ctx.externalPage, 'assertOpeningRecordsNothing');
    await expect(external.getByRole('region', { name: 'Client documents' })).toBeVisible();
    await expect(ctx.page.getByRole('region', { name: 'Client documents' })).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const before = new Set(ctx.state.auditIdsBeforeOpen);
    const { events } = await ctx.evidence.listAudit(ref);

    const added = events.filter((event) => !before.has(event.id));
    expect(
      added.map((event) => event.action),
      'opening the data room wrote an audit row',
    ).toEqual([]);
    expect(
      events.some((event) => event.action === 'view'),
      'a view event was recorded',
    ).toBe(false);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
