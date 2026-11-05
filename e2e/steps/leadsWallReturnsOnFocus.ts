import { expect } from '@playwright/test';
import { ACCESS_DESTINATION, ACCESS_DESTINATION_DEFS } from '@/lib/constants/accessRequests';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { refocusTab } from '../support/focus';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requireEvidence, requireNav, requirePage, type Step } from './types';

const LEADS_LABEL = ACCESS_DESTINATION_DEFS[ACCESS_DESTINATION.LEADS].label;
const WALL_TIMEOUT_MS = 20_000;

export const leadsWallReturnsOnFocus: Step = {
  name: 'leadsWallReturnsOnFocus',

  async act(ctx) {
    const page = requirePage(ctx.employeePage, 'leadsWallReturnsOnFocus');
    requireNav(ctx.employeeNav, 'leadsWallReturnsOnFocus').reset();

    await refocusTab(page);
    await page
      .getByRole('region', { name: `Access needed for ${LEADS_LABEL}` })
      .waitFor({ state: 'visible', timeout: WALL_TIMEOUT_MS });
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.employeePage, 'leadsWallReturnsOnFocus');
    const wall = page.getByRole('region', { name: `Access needed for ${LEADS_LABEL}` });

    await expect(
      wall.getByText(
        `You need permission from an organization administrator to use ${LEADS_LABEL}.`,
      ),
    ).toBeVisible();
    await expect(wall.getByRole('button', { name: 'Request access' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Registered leads' })).toHaveCount(0);
  },

  async verify(ctx) {
    const page = requirePage(ctx.employeePage, 'leadsWallReturnsOnFocus');
    const evidence = requireEvidence(ctx.employeeEvidence, 'leadsWallReturnsOnFocus');

    const profile = await evidence.me();
    expect(
      (profile.company_permissions ?? []).map((permission) => permission.permissionKey),
    ).not.toContain(COMPANY_PERMISSION.LEADS_VIEW);

    expect(
      requireNav(ctx.employeeNav, 'leadsWallReturnsOnFocus').count,
      'the member page navigated; the revocation did not land in place',
    ).toBe(0);
    expect(new URL(page.url()).pathname).toBe('/leads');

    await expectSingleComplianceInstrument(page);
  },
};
