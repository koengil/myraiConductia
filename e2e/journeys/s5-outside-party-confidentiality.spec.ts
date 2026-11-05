import type { Browser, Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { EXTERNAL_EMAIL, EXTERNAL_STATE_PATH, seededStorageState } from '../auth/session';

/**
 * What an outside party on the seeded Atlas deal can and cannot reach, in a
 * real browser:
 *   - the buyer's Team shows the bank's deal team and their own side only:
 *     no seller name or email, and no "Data room access" list;
 *   - the buyer cannot open the Book deal view (bank fee, schedule and
 *     roll-up): the shell sends them to the deal home;
 *   - the seller's deal navigation offers neither Rails nor Leads.
 * The server still answers the underlying reads (handoff E25, E26); these
 * pin what the UI shows.
 */

const ATLAS = 'ATLAS-2026-001';
/** scripts/seed-data.ts: emailSlug 'buyer', the Atlas buyer seat. */
const BUYER_EMAIL = 'buyer.intelibank@dev.com';
/** scripts/seed-data.ts: the seller seat's name. */
const SELLER_NAME = 'Mike Cannon-Brookes';

async function buyerPage(browser: Browser, baseURL: string | undefined) {
  const context = await newCollectedContext(browser, {
    storageState: await seededStorageState(BUYER_EMAIL, baseURL),
    baseURL,
  });
  return { context, page: await context.newPage() };
}

/** The shell's visible primary navigation (TopNav or Sidebar, whichever the flag mounts). */
function primaryNav(page: Page) {
  return page.getByRole('navigation', { name: 'Primary navigation' }).filter({ visible: true }).first();
}

/** Every link in the primary navigation whose name is `label` (or `label: N unread`). */
function navLinks(page: Page, label: string) {
  return primaryNav(page).getByRole('link', { name: new RegExp(`^${label}(: \\d+ unread)?$`) });
}

/** The outside party's deal home has loaded: its welcome brief, named by the deal. */
async function expectDealHome(page: Page) {
  const brief = page.getByTestId('welcome-brief');
  await expect(brief).toBeVisible();
  await expect(brief.getByRole('heading', { name: 'Project Atlas' })).toBeVisible();
}

test.describe('outside parties on Atlas', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name === 'live', 'the buyer and the seller are seeded local accounts');
  });

  test('the buyer\'s Team names no seller and shows no Data room access list', async ({ browser, baseURL }) => {
    const { context, page } = await buyerPage(browser, baseURL);
    try {
      await page.goto(`/projects/${ATLAS}/team`);
      await expect(page).toHaveURL(new RegExp(`/projects/${ATLAS}/team`));
      await expect(page.getByRole('heading', { name: "The bank's deal team" })).toBeVisible();
      const main = page.getByRole('main');
      await expect(main.getByText(SELLER_NAME)).toHaveCount(0);
      await expect(main.getByText(EXTERNAL_EMAIL)).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Data room access' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('the buyer cannot open the Book deal view', async ({ browser, baseURL }) => {
    const { context, page } = await buyerPage(browser, baseURL);
    try {
      await page.goto(`/projects/${ATLAS}/book`);
      await expect(page).toHaveURL(new RegExp(`/projects/${ATLAS}/?$`));
      await expectDealHome(page);
      await expect(page.getByRole('heading', { name: /Deal console/ })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('the seller\'s deal navigation offers neither Rails nor Leads', async ({ browser, baseURL }) => {
    const context = await newCollectedContext(browser, { storageState: EXTERNAL_STATE_PATH, baseURL });
    try {
      const page = await context.newPage();
      await page.goto(`/projects/${ATLAS}`);
      await expectDealHome(page);
      await expect(navLinks(page, 'Team').first()).toBeVisible();
      await expect(navLinks(page, 'Rails')).toHaveCount(0);
      await expect(navLinks(page, 'Leads')).toHaveCount(0);
      // Nor under the nav's More menu, where one exists.
      const more = primaryNav(page).getByRole('button', { name: /^More/ }).first();
      if (await more.isVisible()) {
        await more.click();
        await expect(page.getByRole('menu')).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /^(Rails|Leads)\b/ })).toHaveCount(0);
        await page.keyboard.press('Escape');
      }
    } finally {
      await context.close();
    }
  });
});
