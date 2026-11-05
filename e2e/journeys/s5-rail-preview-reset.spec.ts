import type { Page, Request } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { createRailDeal } from '../support/railDealFixture';
import {
  MOVED_IN_BROWSER,
  RAIL_MOVE_PROMPT_SCOPE,
  escapeRegExp,
  moveStepFromCard,
  openPhaseOf,
  railStepTitle,
  zoomOutToBoard,
} from '../support/rail';

/**
 * The deal rail's reorder Preview in a real browser: Storm moves a step with
 * "Move to…", the prompt says the order is kept in this browser and not saved,
 * and Reset puts the saved order back. Nothing is written: no request other
 * than a GET leaves the page from the move to the reset.
 */

const MOVED_STEP_ID = 'p2-s29';

/** The step cards of the moved step's phase, in board order. */
async function phaseOrder(page: Page): Promise<(string | null)[]> {
  return page
    .getByRole('region', { name: 'Rail overview' })
    .getByRole('list', { name: /^Preparation.* steps$/ })
    .getByRole('button', { name: /^Step \d+ · / })
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')));
}

/** Every same-origin request that is not a read, from now until `stop`. */
function recordWrites(page: Page, origin: string) {
  const writes: string[] = [];
  const onRequest = (request: Request) => {
    const method = request.method();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (!request.url().startsWith(origin)) return;
    writes.push(`${method} ${new URL(request.url()).pathname}`);
  };
  page.on('request', onRequest);
  return {
    writes,
    stop: () => page.off('request', onRequest),
  };
}

test('a Preview move says it is kept in this browser, and Reset restores the saved order with nothing sent', async ({
  page,
  evidence,
  runId,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'live', 'the journey creates its own deal on the local stack');

  const deal = await createRailDeal(evidence.request, { runId });
  await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
  const overview = page.getByRole('region', { name: 'Rail overview' });
  await expect(overview).toBeVisible();
  await openPhaseOf(page, MOVED_STEP_ID);
  const title = railStepTitle(MOVED_STEP_ID);
  await expect(overview.getByRole('button', { name: new RegExp(`· ${escapeRegExp(title)} · `) })).toBeVisible();
  const savedOrder = await phaseOrder(page);

  const recorder = recordWrites(page, new URL(baseURL!).origin);
  try {
    await moveStepFromCard(page, MOVED_STEP_ID);

    // The prompt states the Preview truth, and offers no Apply.
    const prompt = page.getByRole('dialog', { name: `${title} moved` });
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText(RAIL_MOVE_PROMPT_SCOPE)).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Apply to this deal' })).toHaveCount(0);
    await prompt.getByRole('button', { name: 'Keep in this browser' }).click();
    await expect(prompt).toHaveCount(0);
    await zoomOutToBoard(page);

    await expect(overview.getByText(MOVED_IN_BROWSER)).toBeVisible();
    expect(await phaseOrder(page), 'the move changed nothing on the board').not.toEqual(savedOrder);
    const banner = page.locator('[data-preview="banner"]').first();
    await expect(banner).toContainText('Nothing here is saved to the deal.');

    await banner.getByRole('button', { name: 'Reset' }).click();
    await expect(overview.getByText(MOVED_IN_BROWSER)).toHaveCount(0);
    await expect(page.locator('[data-preview="banner"]')).toHaveCount(0);
    // The saved order is back.
    await expect.poll(() => phaseOrder(page)).toEqual(savedOrder);
  } finally {
    recorder.stop();
  }
  expect(recorder.writes, 'the Preview move or its Reset sent a write').toEqual([]);
});
