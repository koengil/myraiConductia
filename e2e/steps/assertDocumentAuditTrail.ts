import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

export const assertDocumentAuditTrail: Step = {
  name: 'assertDocumentAuditTrail',

  async act(ctx) {
    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/audit`);
    await ctx.page
      .getByRole('group', { name: 'Filter audit events' })
      .getByRole('button', { name: 'Documents' })
      .click();
  },

  async assertUi(ctx) {
    await expect(ctx.page.getByText('Uploaded a document', { exact: true })).toHaveCount(2);
    await expect(ctx.page.getByText('Downloaded a document', { exact: true })).toHaveCount(1);
    await expect(
      ctx.page.getByText(ctx.state.dealFolderDocumentName as string).first(),
    ).toBeVisible();
    await expect(ctx.page.getByText(ctx.state.documentName as string).first()).toBeVisible();
  },

  async verify(ctx) {
    const ref = ctx.state.dealCode as string;
    const { events } = await ctx.evidence.listAudit(ref);
    const since = (action: string) =>
      events.filter((event) => event.action === action && event.ts >= ctx.since);

    expect(since('upload').map((event) => event.id)).toHaveLength(2);
    expect(since('download').map((event) => event.id)).toHaveLength(1);
    expect(since('view').map((event) => event.id)).toHaveLength(0);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
