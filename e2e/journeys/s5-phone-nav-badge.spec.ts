import { test, expect } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { MEMBER_EMAIL, MEMBER_STATE_PATH } from '../auth/session';
import { createRailDeal } from '../support/railDealFixture';
import { MEMBER_STEP_ID, escapeRegExp } from '../support/rail';
import type { Evidence } from '../support/evidence';

/**
 * The phone bottom bar at 390px: once the MD assigns the member a step, the
 * member's Rails cell carries a count badge, and the badge opens the deal by
 * its code (never its database id).
 */

async function memberUserId(evidence: Evidence): Promise<string> {
  const me = await evidence.me();
  const companyId = me.company?.id;
  expect(companyId, "the MD's own company id is required to resolve the member").toBeTruthy();
  const { members } = await evidence.listCompanyMembers(companyId!);
  const member = members.find((m) => m.email === MEMBER_EMAIL);
  expect(member, `no company member found at ${MEMBER_EMAIL}`).toBeTruthy();
  return member!.id;
}

test('at 390px the Rails cell shows the step notification, and its link uses the deal code', async ({
  evidence,
  runId,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name === 'live', 'the member is a seeded local account');

  const memberId = await memberUserId(evidence);
  const deal = await createRailDeal(evidence.request, { runId, memberIds: [memberId] });
  const assign = await evidence.request.patch(
    `/api/v1/deals/${encodeURIComponent(deal.code)}/steps/${MEMBER_STEP_ID}`,
    { data: { assignTo: memberId } },
  );
  expect(assign.ok(), await assign.text()).toBeTruthy();

  const context = await newCollectedContext(browser, {
    storageState: MEMBER_STATE_PATH,
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/projects/${encodeURIComponent(deal.code)}/rail`);
    const bar = page.getByRole('navigation', { name: 'Primary navigation' });
    await expect(bar).toBeVisible();
    const rails = bar.getByRole('link', { name: /^Rails: \d+ unread$/ });
    await expect(rails).toBeVisible();
    await expect(rails).toHaveAttribute('href', new RegExp(`^/projects/${escapeRegExp(deal.code)}/rail`));
    await expect(rails).not.toHaveAttribute('href', new RegExp(escapeRegExp(deal.id)));
  } finally {
    await context.close();
  }
});
