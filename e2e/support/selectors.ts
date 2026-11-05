import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The one deliberate exception to the role-first selector contract. Compliance
 * is mounted exactly once by invariant (ComplianceRibbon in the floating
 * command console); that invariant is the thing worth testing, and
 * [data-compliance-status] is already the sanctioned hook for it. Asserted by
 * every verify(), so the invariant is checked continuously.
 *
 * The floating command console is scoped to project routes
 * (`src/components/shell/AppShell.tsx`), so the instrument is mounted exactly
 * once on `/projects/[id]/...` routes and not at all elsewhere (e.g. `/leads`).
 */
export async function expectSingleComplianceInstrument(page: Page): Promise<void> {
  const isProjectRoute = /\/projects\/[^/]+/.test(new URL(page.url()).pathname);
  await expect(page.locator('[data-compliance-status]')).toHaveCount(isProjectRoute ? 1 : 0);
}

/**
 * One pending invitation on the Team roster. Every pending row renders the
 * same "Resend" and "Revoke" buttons, so the invitee's address is the only
 * thing that tells two rows apart.
 */
export function pendingInviteRow(page: Page, email: string): Locator {
  return page.getByRole('listitem').filter({ hasText: email });
}
