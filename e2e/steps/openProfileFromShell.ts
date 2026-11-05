import { expect } from '@playwright/test';
import { expectProfileMatchesApi, PROFILE_FIELDS, profileRow } from '../support/profile';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

export const openProfileFromShell: Step = {
  name: 'openProfileFromShell',

  async act(ctx) {
    await ctx.page.goto('/projects');
    await ctx.page.getByRole('button', { name: /open profile menu$/ }).click();
    // The profile panel links to Settings, whose first section is the profile.
    await ctx.page.getByRole('dialog', { name: 'Profile' }).getByRole('link', { name: 'Settings' }).click();
  },

  async assertUi(ctx) {
    await expect(ctx.page).toHaveURL(/\/settings$/);
    await expect(
      ctx.page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'Profile', exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    for (const field of PROFILE_FIELDS) {
      await expect(profileRow(ctx.page, field), `the profile does not render ${field}`).toBeVisible();
    }
    await expect(ctx.page.getByRole('button', { name: 'Edit full name' })).toBeVisible();
    await expect(ctx.page.getByRole('button', { name: 'Change photo' })).toBeVisible();
  },

  async verify(ctx) {
    const me = await ctx.evidence.me();
    await expectProfileMatchesApi(ctx.page, me);

    ctx.state.mdFullName = me.user.full_name;

    await expectSingleComplianceInstrument(ctx.page);
  },
};
