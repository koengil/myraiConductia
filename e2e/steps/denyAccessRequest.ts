import { expect, type Locator, type Page } from '@playwright/test';
import {
  ACCESS_DESTINATION,
  ACCESS_DESTINATION_DEFS,
  ACCESS_REQUEST_STATUS,
} from '@/lib/constants/accessRequests';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { expectSingleComplianceInstrument } from '../support/selectors';
import { requireEvidence, type Step } from './types';

const CREATE_LEADS_LABEL = ACCESS_DESTINATION_DEFS[ACCESS_DESTINATION.LEADS_CREATE].label;

function accessRequestRow(page: Page): Locator {
  return page
    .getByRole('dialog', { name: 'Notifications' })
    .getByRole('listitem')
    .filter({ hasText: CREATE_LEADS_LABEL })
    .first();
}

export const denyAccessRequest: Step = {
  name: 'denyAccessRequest',

  async act(ctx) {
    await ctx.page.goto('/projects');
    await ctx.page.getByRole('button', { name: /^Notifications, \d+ unread$/ }).click();

    const row = accessRequestRow(ctx.page);
    await expect(row).toContainText('Access request');
    await expect(row).toContainText(`${CREATE_LEADS_LABEL} · ${ctx.state.employeeName}`);
    await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible();
    await row.getByRole('button', { name: 'Deny' }).click();
  },

  async assertUi(ctx) {
    const row = accessRequestRow(ctx.page);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Deny' })).toHaveCount(0);
  },

  async verify(ctx) {
    const companyId = ctx.state.companyId as string;
    const employeeUserId = ctx.state.employeeUserId as string;

    const { access } = await ctx.evidence.getMemberAccess(companyId, employeeUserId);
    const granted = access.effective_permissions.find(
      (permission) => permission.permissionKey === COMPANY_PERMISSION.LEADS_CREATE,
    );
    expect(granted, 'Deny must not grant Create leads').toBeUndefined();

    const { inbox } = await ctx.evidence.listAccessRequests();
    expect(
      inbox.filter((request) => request.requesterId === employeeUserId),
      'the decided request is still queued for the director',
    ).toEqual([]);

    const employeeEvidence = requireEvidence(ctx.employeeEvidence, 'denyAccessRequest');
    const { mine } = await employeeEvidence.listAccessRequests();
    const decided = mine.find((request) => request.destination === ACCESS_DESTINATION.LEADS_CREATE);
    expect(decided?.status, 'the request must be recorded as denied').toBe(
      ACCESS_REQUEST_STATUS.DENIED,
    );

    await expectSingleComplianceInstrument(ctx.page);
  },
};
