import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { createRailDeal } from '../support/railDealFixture';
import { MOVED_IN_BROWSER, RAIL_MOVE_PROMPT_SCOPE, moveStepFromCard, openPhaseOf, railStepTitle } from '../support/rail';

/**
 * Settings › Rails and the rail's edit prompt, round trip in a real browser:
 * with "Ask before changing the rail" off, a Preview move raises no prompt;
 * switched back on, the next move raises it. The choice is kept in this
 * browser (localStorage), so both halves run in one browser context.
 */

const STEP_ID = 'p2-s29';

async function setAskBeforeChanging(page: Page, on: boolean): Promise<void> {
  await page.goto('/settings?section=rails');
  const toggle = page.getByRole('checkbox', { name: 'Ask before changing the rail' });
  await expect(toggle).toBeEnabled();
  await toggle.setChecked(on);
  await expect(toggle).toBeChecked({ checked: on });
}

async function openRail(page: Page, dealCode: string): Promise<void> {
  await page.goto(`/projects/${encodeURIComponent(dealCode)}/rail`);
  await expect(page.getByRole('region', { name: 'Rail overview' })).toBeVisible();
  await openPhaseOf(page, STEP_ID);
}

test('Settings › Rails off: a move raises no prompt; back on: the next move raises it', async ({
  page,
  evidence,
  runId,
}, testInfo) => {
  test.skip(testInfo.project.name === 'live', 'the journey creates its own deal on the local stack');

  const deal = await createRailDeal(evidence.request, { runId });
  const prompt = page.getByRole('dialog').filter({ hasText: RAIL_MOVE_PROMPT_SCOPE });
  const overview = page.getByRole('region', { name: 'Rail overview' });

  // Off: the move lands (the card is marked) and nothing asks.
  await setAskBeforeChanging(page, false);
  await openRail(page, deal.code);
  await moveStepFromCard(page, STEP_ID);
  await expect(overview.getByText(MOVED_IN_BROWSER)).toBeVisible();
  await expect(prompt).toHaveCount(0);

  // On: a fresh load of the rail (the Preview order is memory only), and the move asks.
  await setAskBeforeChanging(page, true);
  await openRail(page, deal.code);
  await expect(overview.getByText(MOVED_IN_BROWSER)).toHaveCount(0);
  await moveStepFromCard(page, STEP_ID);
  await expect(prompt).toBeVisible();
  await expect(page.getByRole('dialog', { name: `${railStepTitle(STEP_ID)} moved` })).toBeVisible();
});
