import { expect } from '@playwright/test';
import { startsWith } from '../support/regexp';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { expandLead, relationshipRow } from './leadDetail';
import type { Step } from './types';

const FREE_TYPED_NAME = 'Unlisted Freetyped Contact';

export const addLeadRelationship: Step = {
  name: 'addLeadRelationship',

  async act(ctx) {
    const me = await ctx.evidence.me();
    const { people } = await ctx.evidence.listCompanyEmployees();
    const colleague = people.find((person) => person.id !== `company-user:${me.user.id}`);
    expect(
      colleague,
      'the seeded firm roster carries no second employee to relate the lead to',
    ).toBeTruthy();
    const colleagueName = (colleague as { name: string }).name;
    ctx.state.relationshipPersonName = colleagueName;

    await ctx.page.goto('/leads');
    await expandLead(ctx);
    await ctx.page.getByRole('button', { name: 'Add relationship' }).click();

    const person = ctx.page.getByRole('combobox', { name: 'Person' });
    const save = ctx.page.getByRole('button', { name: 'Save relationship' });
    await expect(save).toBeDisabled();

    await person.fill(colleagueName);
    await expect(person).toHaveAttribute('aria-expanded', 'true');
    await expect(
      save,
      'Save relationship must stay disabled while a matching name is only typed',
    ).toBeDisabled();

    await person.fill(FREE_TYPED_NAME);
    await expect(person).toHaveAttribute('aria-expanded', 'false');
    await expect(
      save,
      'Save relationship must stay disabled for a name no suggestion backs',
    ).toBeDisabled();

    await person.fill(colleagueName);
    await ctx.page.getByRole('option', { name: startsWith(colleagueName) }).click();
    await expect(person).toHaveValue(colleagueName);
    await expect(save).toBeEnabled();
    await save.click();
  },

  async assertUi(ctx) {
    await expect(relationshipRow(ctx, ctx.state.relationshipPersonName as string)).toBeVisible();
    await expect(relationshipRow(ctx, FREE_TYPED_NAME)).toHaveCount(0);
  },

  async verify(ctx) {
    const { relationships } = await ctx.evidence.listRelationships(
      ctx.state.leadCompanyId as string,
    );
    const saved = relationships.filter(
      (row) => row.person_name === ctx.state.relationshipPersonName,
    );
    expect(saved, 'the chosen colleague is not on the lead relationship map').toHaveLength(1);
    expect(
      relationships.map((row) => row.person_name),
      'a free-typed name reached the relationship map',
    ).not.toContain(FREE_TYPED_NAME);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
