import { expect, type Page } from '@playwright/test';

/**
 * With work sign-in on, /sign-in shows the Google and Microsoft buttons and
 * keeps the email and password fields behind "Or sign in with email". Open
 * them when that button is there; do nothing when the fields are already the
 * page (work sign-in off). Call it before touching the Email or Password field
 * or the "Sign in" button.
 *
 * It waits for the page to show one or the other before it branches, so it
 * never decides on a page that has not painted, and it retries the click until
 * the fields appear (the button can paint before the page hydrates).
 */
export async function openEmailSignIn(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Or sign in with email' });
  const email = page.getByLabel('Email');
  // The toggle stays rendered once open, so both can match: take the first.
  await expect(toggle.or(email).first()).toBeVisible();
  if (await email.isVisible()) return;
  await expect(async () => {
    await toggle.click();
    await expect(email).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}
