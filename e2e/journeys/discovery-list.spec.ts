import { MEMBER_STATE_PATH } from '../auth/session';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';

/**
 * Deal discovery, phase 3: the /discovery list is RLS-first. The fixture
 * corpus (scripts/seed-discovery.ts) gives the MD, Storm Duncan, Project
 * Falcon mail, gives Project Cobra mail only to a colleague, and gives the
 * bank member, Alex Chen, a mailbox with no deal mail at all.
 *
 * Hermetic only: it needs the seeded fixture corpus and the member session,
 * neither of which a deployed target is guaranteed to have.
 */
test.skip(Boolean(process.env.E2E_BASE_URL), 'needs the fixture corpus from seed-discovery');

test('the MD sees Falcon on /discovery, and a banker with no evidence sees the empty state', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/discovery');
  await expect(page.getByRole('heading', { level: 1, name: 'Proposed deals' })).toBeVisible();
  const falcon = page.getByRole('heading', { name: 'Project Falcon' });
  await expect(falcon).toBeVisible();
  // With the demo corpus seeded, Kestrel's newer mail puts it first: scope to Falcon's own row.
  const falconRow = page.locator('[data-candidate-id]').filter({ has: falcon });
  await expect(falconRow.getByRole('list', { name: 'Parties' })).toContainText('Heliotrope');
  await expect(falconRow.getByText('6 evidence items, 5 from your mailbox')).toBeVisible();
  // Cobra's mail is a colleague's alone: the MD never sees it.
  await expect(page.getByRole('heading', { name: 'Project Cobra' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Discovery' }).first()).toHaveAttribute('aria-current', 'page');

  const memberContext = await newCollectedContext(browser, { baseURL, storageState: MEMBER_STATE_PATH });
  try {
    const memberPage = await memberContext.newPage();
    await memberPage.goto('/discovery');
    await expect(
      memberPage.getByText('No proposed deals. A deal appears here once your own mail is evidence for it.'),
    ).toBeVisible();
    await expect(memberPage.getByRole('heading', { name: 'Project Falcon' })).toHaveCount(0);
  } finally {
    await memberContext.close();
  }
});
