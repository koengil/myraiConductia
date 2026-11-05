import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * Step 1 — register a lead on /leads. The lead persists as a `client`-type
 * company via POST /api/v1/companies and becomes selectable in the Gate 0
 * wizard's lead typeahead, which is how step 2 reaches it.
 */
export const registerLead: Step = {
  name: 'registerLead',

  async act(ctx) {
    ctx.state.leadName = `E2E Lead ${ctx.runId}`;

    await ctx.page.goto('/leads');
    await ctx.page.getByRole('button', { name: 'Register a lead' }).first().click();

    const dialog = ctx.page.getByRole('dialog', { name: 'Register a lead' });
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder('Company name (e.g. Atlassian)').fill(ctx.state.leadName);
    const created = ctx.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/companies' &&
        response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Register lead' }).click();
    const response = await created;
    expect(response.status(), 'POST /api/v1/companies').toBe(201);
    ctx.state.registeredCompany = ((await response.json()) as {
      company: { id: string; name: string; type: string };
    }).company;
  },

  async assertUi(ctx) {
    const leadName = ctx.state.leadName as string;
    await expect(
      ctx.page.getByRole('region', { name: 'Registered leads' }).getByText(leadName, { exact: true }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const leadName = ctx.state.leadName as string;
    const lead = ctx.state.registeredCompany;
    expect(lead, `no 201 company body captured for "${leadName}" from POST /api/v1/companies`).toBeTruthy();
    expect(lead?.name).toBe(leadName);
    expect(lead?.type).toBe('client');
    expect(lead?.id).toBeTruthy();
    ctx.state.leadCompanyId = lead?.id;

    await expectSingleComplianceInstrument(ctx.page);
  },
};
