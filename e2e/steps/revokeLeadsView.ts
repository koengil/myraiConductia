import { expect } from '@playwright/test';
import {
  COMPANY_PERMISSION,
  COMPANY_PERMISSION_LABELS,
} from '@/lib/constants/companyPermissions';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

const VIEW_LEADS_LABEL = COMPANY_PERMISSION_LABELS[COMPANY_PERMISSION.LEADS_VIEW];

export const revokeLeadsView: Step = {
  name: 'revokeLeadsView',

  async act(ctx) {
    await ctx.page.goto(`/companies/${ctx.state.companyId}/members`);

    // Rows open inline (no drawer); editing is the explicit "Edit access" step.
    const row = ctx.page
      .locator('li[data-member]')
      .filter({ hasText: ctx.state.employeeEmail as string });
    await row.getByRole('button', { name: `Actions for ${ctx.state.employeeName}` }).click();
    await ctx.page.getByRole('menuitem', { name: 'Edit access' }).click();

    await row.getByRole('checkbox', { name: VIEW_LEADS_LABEL }).uncheck();
    await row.getByRole('button', { name: 'Save access' }).click();
  },

  async assertUi(ctx) {
    const row = ctx.page
      .locator('li[data-member]')
      .filter({ hasText: ctx.state.employeeEmail as string });
    await expect(row.getByRole('status')).toHaveText('Access saved.');
    // Back to read-only: the editor closed, so no permission checkbox is left
    // in the row. The row's own "Select {name}" box (bulk Set access) is not a
    // permission and stays.
    await expect(row.getByRole('checkbox', { name: /^(?!Select ).*/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Save access' })).toHaveCount(0);
    await expect(row.getByText(VIEW_LEADS_LABEL, { exact: true })).toHaveCount(0);
  },

  async verify(ctx) {
    const { access } = await ctx.evidence.getMemberAccess(
      ctx.state.companyId as string,
      ctx.state.employeeUserId as string,
    );
    expect(access.direct_permissions).not.toContain(COMPANY_PERMISSION.LEADS_VIEW);
    expect(
      access.effective_permissions.map((permission) => permission.permissionKey),
    ).not.toContain(COMPANY_PERMISSION.LEADS_VIEW);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
