import { expect, test } from '../support/fixtures';
import { MD_EMAIL } from '../auth/session';

/**
 * The foundation's own smoke: the stored session reaches the authenticated
 * shell without driving /sign-in, and the evidence client authenticates
 * through the same identity via the normal requireApiUser path.
 */
test('the stored MD session lands inside the authenticated shell', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/projects/);
  await expect(
    page.getByRole('button', { name: /Switch deal|Select a deal/ }),
  ).toBeVisible();
});

test('the evidence client reads /api/v1 as the same MD', async ({ evidence, runId }) => {
  const me = await evidence.me();
  expect(me.user.email).toBe(MD_EMAIL);
  expect(runId).toMatch(/^[a-z0-9]{6}$/);
});
