import { expect } from '@playwright/test';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requireEvidence, requireNav, requirePage, type Step } from './types';

const UNLOCK_TIMEOUT_MS = 20_000;

export const leadDialogUnlocksInPlace: Step = {
  name: 'leadDialogUnlocksInPlace',

  async act(ctx) {
    const page = requirePage(ctx.employeePage, 'leadDialogUnlocksInPlace');
    await page
      .getByRole('dialog', { name: 'Register a lead' })
      .getByPlaceholder('Company name (e.g. Atlassian)')
      .waitFor({ state: 'visible', timeout: UNLOCK_TIMEOUT_MS });
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.employeePage, 'leadDialogUnlocksInPlace');
    const dialog = page.getByRole('dialog', { name: 'Register a lead' });

    await expect(dialog.getByPlaceholder('Company name (e.g. Atlassian)')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Register lead' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Access needed to register a lead' }),
    ).toHaveCount(0);
  },

  async verify(ctx) {
    const page = requirePage(ctx.employeePage, 'leadDialogUnlocksInPlace');
    const evidence = requireEvidence(ctx.employeeEvidence, 'leadDialogUnlocksInPlace');

    const profile = await evidence.me();
    expect(
      (profile.company_permissions ?? []).map((permission) => permission.permissionKey),
    ).toContain(COMPANY_PERMISSION.LEADS_CREATE);

    expect(
      requireNav(ctx.employeeNav, 'leadDialogUnlocksInPlace').count,
      'the member page navigated; the grant did not land in place',
    ).toBe(0);
    expect(new URL(page.url()).pathname).toBe('/leads');

    await expectSingleComplianceInstrument(page);
  },
};
