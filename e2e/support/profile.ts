import { expect, type Locator, type Page } from '@playwright/test';
import type { MeResponse } from './evidence';

/** Settings › Profile rows, in order. */
export const PROFILE_FIELDS = ['Full name', 'Nickname', 'Title', 'Role', 'Email'];

/** One Settings › Profile row (dt label + dd value), by its label. */
export function profileRow(page: Page, label: string): Locator {
  return page
    .locator('[data-profile-field]')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) });
}

export function expectedProfileFields(me: MeResponse) {
  const fullName = me.user.full_name?.trim() ?? '';
  const displayName = me.user.display_name?.trim() ?? '';
  return {
    email: me.user.email,
    fullName,
    // The Profile page's nicknameShown rule (ProfileView): a nickname that is
    // missing, or only repeats the full name, shows as no nickname ("Not set").
    // Seeded users carry display_name equal to full_name, so they read "Not set".
    nickname: displayName && displayName !== fullName ? displayName : '',
  };
}

export async function expectProfileMatchesApi(page: Page, me: MeResponse): Promise<void> {
  const expected = expectedProfileFields(me);

  await expect(profileRow(page, 'Full name').locator('dd')).toContainText(expected.fullName);
  const nickname = profileRow(page, 'Nickname').locator('dd');
  if (expected.nickname) {
    await expect(nickname).toHaveText(expected.nickname);
  } else {
    await expect(nickname).toHaveText('Not set');
  }
  await expect(profileRow(page, 'Email').locator('dd')).toHaveText(expected.email);
  // The email shows once.
  await expect(page.getByText(expected.email, { exact: true })).toHaveCount(1);
  await expect(profileRow(page, 'Role')).toBeVisible();
}
