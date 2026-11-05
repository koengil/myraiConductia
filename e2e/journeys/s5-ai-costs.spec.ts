import { test, expect } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { ADMIN_STATE_PATH } from '../auth/session';
import { insertAiUsage } from '../support/aiUsageFixture';
import { createRailDeal } from '../support/railDealFixture';

/**
 * /ai-costs for the firm administrator: the page loads and breaks the firm's
 * recorded AI spend down by deal, person, task and model. One priced call is
 * recorded on a deal created here, so a fresh database has spend to show.
 */
test('AI costs loads for the firm admin with spend by deal, person, task and model', async ({
  evidence,
  runId,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'live', 'the spend row is written straight to the local ledger');

  const deal = await createRailDeal(evidence.request, { runId });
  const me = await evidence.me();
  await insertAiUsage({ dealId: deal.id, actorId: me.user.id, runId });

  const context = await newCollectedContext(browser, { storageState: ADMIN_STATE_PATH, baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/ai-costs');
    await expect(page).toHaveURL(/\/ai-costs$/);
    await expect(page.getByRole('heading', { level: 1, name: 'AI costs' })).toBeVisible();
    for (const breakdown of ['By deal', 'By person', 'By task', 'By model']) {
      await expect(page.getByRole('table', { name: breakdown }), breakdown).toBeVisible();
    }
  } finally {
    await context.close();
  }
});
