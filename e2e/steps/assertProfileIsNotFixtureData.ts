import { expect } from '@playwright/test';
import { expectProfileMatchesApi, profileRow } from '../support/profile';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * Runs on a second seeded banker, not the MD: the seeded MD IS the fixture
 * persona (scripts/seed-data.ts names him Storm Duncan), so asserting the
 * fixture is absent from his own profile would pass whatever the page
 * rendered.
 */
export const assertProfileIsNotFixtureData: Step = {
  name: 'assertProfileIsNotFixtureData',

  async act(ctx) {
    const page = requirePage(ctx.secondPage, 'assertProfileIsNotFixtureData');
    // /profile redirects to Settings › Profile.
    await page.goto('/profile');
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.secondPage, 'assertProfileIsNotFixtureData');
    await expect(page).toHaveURL(/\/settings\?section=profile$/);
    await expect(profileRow(page, 'Full name')).toBeVisible();

    const mdName = ctx.state.mdFullName;
    expect(mdName, 'the MD identity was never read').toBeTruthy();
    await expect(
      page.getByText(mdName as string),
      'another person’s profile carries the fixture persona',
    ).toHaveCount(0);
  },

  async verify(ctx) {
    const page = requirePage(ctx.secondPage, 'assertProfileIsNotFixtureData');
    const evidence = requireEvidence(ctx.secondEvidence, 'assertProfileIsNotFixtureData');

    const me = await evidence.me();
    expect(
      me.user.full_name,
      'the second identity is the fixture persona; the check above proves nothing',
    ).not.toBe(ctx.state.mdFullName);

    await expectProfileMatchesApi(page, me);
  },
};
