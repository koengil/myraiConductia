import { expect } from '@playwright/test';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requireEvidence, requirePage, type Step } from './types';

/**
 * Unlike a grant, a denial has no live-poll counterpart on the employee's
 * side: useRequestAccess() only reads /api/v1/access-requests on mount, so
 * the dialog keeps showing "waiting for an administrator" until it remounts.
 * A reload is the realistic next thing the employee does, and it is also
 * the only way the product itself surfaces the decision to them.
 */
export const leadCreateStaysLockedAfterDenial: Step = {
  name: 'leadCreateStaysLockedAfterDenial',

  async act(ctx) {
    const page = requirePage(ctx.employeePage, 'leadCreateStaysLockedAfterDenial');
    await page.reload();
    await page.getByRole('button', { name: 'Register a lead' }).first().click();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.employeePage, 'leadCreateStaysLockedAfterDenial');
    const wall = page.getByRole('region', { name: 'Access needed to register a lead' });

    await expect(wall).toBeVisible();
    await expect(
      page
        .getByRole('dialog', { name: 'Register a lead' })
        .getByPlaceholder('Company name (e.g. Atlassian)'),
    ).toHaveCount(0);
    await expect(wall.getByRole('button', { name: 'Request access' })).toBeVisible();
    await expect(wall.getByRole('status')).toHaveCount(0);

    await page.getByRole('dialog', { name: 'Register a lead' }).getByRole('button', { name: 'Close' }).click();
    await expect(wall).toHaveCount(0);

    await page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();
    await expect(
      page.getByRole('dialog', { name: 'Notifications' }).getByText('Access denied').first(),
    ).toBeVisible();
  },

  async verify(ctx) {
    const page = requirePage(ctx.employeePage, 'leadCreateStaysLockedAfterDenial');
    const evidence = requireEvidence(ctx.employeeEvidence, 'leadCreateStaysLockedAfterDenial');

    const profile = await evidence.me();
    expect(
      (profile.company_permissions ?? []).map((permission) => permission.permissionKey),
    ).not.toContain(COMPANY_PERMISSION.LEADS_CREATE);

    await expectSingleComplianceInstrument(page);
  },
};
