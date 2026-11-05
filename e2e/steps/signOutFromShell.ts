import { expect, request as playwrightRequest } from '@playwright/test';
import { requirePage } from './types';
import type { Step } from './types';
import { openEmailSignIn } from '../support/signIn';

/**
 * Driven on the second identity, never the MD: signing out revokes the session
 * behind the storage state, and e2e/auth/.state/md.json is shared with every
 * other spec in the suite.
 */
export const signOutFromShell: Step = {
  name: 'signOutFromShell',

  async act(ctx) {
    const page = requirePage(ctx.secondPage, 'signOutFromShell');
    await page.goto('/projects');

    ctx.state.preSignOutState = await page.context().storageState();

    await page.getByRole('button', { name: /open profile menu$/ }).click();
    await page.getByRole('dialog', { name: 'Profile' }).getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/sign-in/);
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.secondPage, 'signOutFromShell');

    await openEmailSignIn(page);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /open profile menu$/ })).toHaveCount(0);

    await page.goto('/projects');
    await expect(page).toHaveURL(/\/sign-in\?redirectTo=%2Fprojects$/);
    await openEmailSignIn(page);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  },

  async verify(ctx) {
    const page = requirePage(ctx.secondPage, 'signOutFromShell');

    const live = await page.request.get('/api/v1/me');
    expect(live.status(), 'the signed-out browser still reads /api/v1/me').toBe(401);

    const jar = ctx.state.preSignOutState;
    expect(jar, 'the pre-logout cookie jar was never captured').toBeTruthy();

    const replay = await playwrightRequest.newContext({
      baseURL: new URL(page.url()).origin,
      storageState: jar,
    });
    try {
      const replayed = await replay.get('/api/v1/me');
      expect(replayed.status(), 'the pre-logout session survived sign-out').toBe(401);
    } finally {
      await replay.dispose();
    }
  },
};
