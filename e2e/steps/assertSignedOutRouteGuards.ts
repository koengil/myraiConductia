import { expect } from '@playwright/test';
import { requirePage } from './types';
import type { Step } from './types';
import { openEmailSignIn } from '../support/signIn';

/**
 * /about carries /projects as its redirectTo rather than itself: it is a
 * retired marketing path, and safeAuthDestination (src/lib/auth/redirect.ts)
 * refuses to hand one back as a post-auth destination.
 */
export const assertSignedOutRouteGuards: Step = {
  name: 'assertSignedOutRouteGuards',

  async act(ctx) {
    const page = requirePage(ctx.anonymousPage, 'assertSignedOutRouteGuards');
    await page.goto('/projects');
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.anonymousPage, 'assertSignedOutRouteGuards');

    await expect(page).toHaveURL(/\/sign-in\?redirectTo=%2Fprojects$/);
    await openEmailSignIn(page);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();

    await page.goto('/terms');
    await expect(page).toHaveURL(/\/terms$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Terms of Service', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);

    // Google's OAuth consent screen and verification review link here (#490 S5).
    await page.goto('/privacy');
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Privacy Policy', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('including the Limited Use requirements')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);

    await page.goto('/about');
    await expect(page).toHaveURL(/\/sign-in\?redirectTo=%2Fprojects$/);
    await openEmailSignIn(page);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  },

  async verify(ctx) {
    const page = requirePage(ctx.anonymousPage, 'assertSignedOutRouteGuards');

    const me = await page.request.get('/api/v1/me');
    expect(me.status(), 'an anonymous caller reached /api/v1/me').toBe(401);

    const { memberships } = await ctx.evidence.me();
    const dealCode = memberships.find((seat) => seat.deal_code)?.deal_code;
    expect(dealCode, 'the MD holds no seat to probe the perimeter with').toBeTruthy();

    const deal = await page.request.get(`/api/v1/deals/${encodeURIComponent(dealCode as string)}`);
    expect(deal.status(), 'an anonymous caller read a deal').toBe(401);
  },
};
