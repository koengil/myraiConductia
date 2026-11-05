import { expect } from '@playwright/test';
import { ACCESS_DESTINATION, ACCESS_REQUEST_STATUS } from '@/lib/constants/accessRequests';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requireEvidence, requireNav, requirePage, type Step } from './types';

export const requestLeadCreateAccess: Step = {
  name: 'requestLeadCreateAccess',

  async act(ctx) {
    const page = requirePage(ctx.employeePage, 'requestLeadCreateAccess');

    await page.goto('/leads');
    await page.getByRole('button', { name: 'Register a lead' }).first().click();

    const wall = page.getByRole('region', { name: 'Access needed to register a lead' });
    await expect(wall).toBeVisible();
    await wall.getByRole('button', { name: 'Request access' }).click();

    requireNav(ctx.employeeNav, 'requestLeadCreateAccess').reset();
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.employeePage, 'requestLeadCreateAccess');
    const wall = page.getByRole('region', { name: 'Access needed to register a lead' });

    await expect(
      wall.getByText(
        'You need permission from an organization administrator to register a lead.',
      ),
    ).toBeVisible();
    await expect(wall.getByRole('status')).toHaveText(
      'Your request is waiting for an administrator.',
    );
    await expect(wall.getByRole('button', { name: 'Request access' })).toHaveCount(0);
  },

  async verify(ctx) {
    const evidence = requireEvidence(ctx.employeeEvidence, 'requestLeadCreateAccess');
    const { mine } = await evidence.listAccessRequests();
    const pending = mine.find(
      (request) =>
        request.destination === ACCESS_DESTINATION.LEADS_CREATE &&
        request.status === ACCESS_REQUEST_STATUS.PENDING,
    );
    expect(
      pending,
      `no pending ${ACCESS_DESTINATION.LEADS_CREATE} request via GET /api/v1/access-requests`,
    ).toBeTruthy();

    await expectSingleComplianceInstrument(requirePage(ctx.employeePage, 'requestLeadCreateAccess'));
  },
};
