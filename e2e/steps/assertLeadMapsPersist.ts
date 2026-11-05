import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { expandLead, relationshipRow, stakeholderRow } from './leadDetail';
import type { Step } from './types';

export const assertLeadMapsPersist: Step = {
  name: 'assertLeadMapsPersist',

  async act(ctx) {
    await ctx.page.goto('/leads');
    await ctx.page.reload();
    await expandLead(ctx);
  },

  async assertUi(ctx) {
    await expect(relationshipRow(ctx, ctx.state.relationshipPersonName as string)).toBeVisible();
    await expect(stakeholderRow(ctx, ctx.state.stakeholderName as string)).toBeVisible();
  },

  async verify(ctx) {
    const companyId = ctx.state.leadCompanyId as string;
    const { relationships } = await ctx.evidence.listRelationships(companyId);
    const { stakeholders } = await ctx.evidence.listStakeholders(companyId);

    expect(
      relationships.filter((row) => row.person_name === ctx.state.relationshipPersonName),
      'the relationship did not survive the reload',
    ).toHaveLength(1);
    expect(
      stakeholders.filter((row) => row.name === ctx.state.stakeholderName),
      'the stakeholder did not survive the reload',
    ).toHaveLength(1);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
