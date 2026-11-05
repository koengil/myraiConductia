import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

export const downloadFromDataRoom: Step = {
  name: 'downloadFromDataRoom',

  async act(ctx) {
    await ctx.page.goto(
      `/projects/${encodeURIComponent(ctx.state.dealCode as string)}/data-room`,
    );

    const link = ctx.page
      .getByRole('region', { name: 'Client documents' })
      .getByRole('link', { name: 'Download' });
    await expect(link).toBeVisible();

    const [download] = await Promise.all([ctx.page.waitForEvent('download'), link.click()]);
    ctx.state.downloadFilename = download.suggestedFilename();
  },

  async assertUi(ctx) {
    expect(ctx.state.downloadFilename).toBe(ctx.state.documentName);
    await expect(
      ctx.page
        .getByRole('region', { name: 'Client documents' })
        .getByText(ctx.state.documentName as string, { exact: true }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const me = await ctx.evidence.me();
    await ctx.evidence.expectAudit(ref, {
      action: 'download',
      actorId: me.user.id,
      since: ctx.since,
    });

    await expectSingleComplianceInstrument(ctx.page);
  },
};
