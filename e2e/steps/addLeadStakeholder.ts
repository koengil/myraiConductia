import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { stakeholderRow } from './leadDetail';
import type { Step } from './types';

export const addLeadStakeholder: Step = {
  name: 'addLeadStakeholder',

  async act(ctx) {
    ctx.state.stakeholderName = `E2E Stakeholder ${ctx.runId}`;

    await ctx.page.getByRole('button', { name: 'Add stakeholder' }).click();
    await ctx.page
      .getByLabel('Name', { exact: true })
      .fill(ctx.state.stakeholderName);
    await ctx.page.getByRole('button', { name: 'Save stakeholder' }).click();
  },

  async assertUi(ctx) {
    await expect(stakeholderRow(ctx, ctx.state.stakeholderName as string)).toBeVisible();
  },

  async verify(ctx) {
    const { stakeholders } = await ctx.evidence.listStakeholders(ctx.state.leadCompanyId as string);
    const saved = stakeholders.filter((row) => row.name === ctx.state.stakeholderName);
    expect(saved, 'the stakeholder is not on the lead stakeholder map').toHaveLength(1);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
