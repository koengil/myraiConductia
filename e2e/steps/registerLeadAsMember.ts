import { expect } from '@playwright/test';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requirePage, type Step } from './types';

export const registerLeadAsMember: Step = {
  name: 'registerLeadAsMember',

  async act(ctx) {
    const page = requirePage(ctx.employeePage, 'registerLeadAsMember');
    ctx.state.leadName = `E2E Access Lead ${ctx.runId}`;

    const dialog = page.getByRole('dialog', { name: 'Register a lead' });
    await dialog.getByPlaceholder('Company name (e.g. Atlassian)').fill(ctx.state.leadName);
    const created = page.waitForResponse(
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
    const page = requirePage(ctx.employeePage, 'registerLeadAsMember');
    await expect(
      page
        .getByRole('region', { name: 'Registered leads' })
        .getByText(ctx.state.leadName as string, { exact: true }),
    ).toBeVisible();
  },

  async verify(ctx) {
    const page = requirePage(ctx.employeePage, 'registerLeadAsMember');
    const leadName = ctx.state.leadName as string;

    const lead = ctx.state.registeredCompany;
    expect(lead, `no 201 company body captured for "${leadName}" from POST /api/v1/companies`).toBeTruthy();
    expect(lead?.name).toBe(leadName);
    expect(lead?.type).toBe('client');
    expect(lead?.id).toBeTruthy();
    ctx.state.leadCompanyId = lead?.id;

    await expectSingleComplianceInstrument(page);
  },
};
