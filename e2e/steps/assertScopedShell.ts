import { expect } from '@playwright/test';
import { requirePage } from './types';
import type { Step } from './types';

/**
 * The desktop rail's per-deal rows for the 'external' perspective, derived
 * from ALLOWED_DESTINATIONS.external (src/lib/perspective/access.ts) mapped
 * through the Sidebar's PER_DEAL_NAV_REST labels, less Rails (showRailsNav). Written out rather than
 * imported: importing the set would let a widened perspective pass a test whose
 * whole job is to notice that it widened.
 */
const OFFERED = ['Team', 'Mail', 'Data Room', 'Audit Trail'];

/**
 * Never offered to a counterparty. 'Ask' is chat, which external does not hold.
 * Rails is withheld from the nav because the rail is bank-internal; a direct
 * visit to /rail still lands and says why it is empty.
 */
const WITHHELD = ['Deal Folder', 'Skills', 'Ask', 'Rails'];

/**
 * Denied destinations, as URL suffixes. This is the load-bearing half of the
 * check below: WITHHELD's toHaveCount(0) is satisfied equally by "correctly
 * withheld" and by "the label was renamed", so a rename regression would pass
 * silently on that assertion alone. DENIED_ROUTES instead attempts real
 * navigation and checks where it lands, which a label rename cannot fake.
 * Note 'Ask' has no route probe here — chat is not a route — so it is
 * protected only by the WITHHELD label string, with no equivalent
 * navigation-based backstop. '/book' is probed too: the e2e stack enables
 * book_view, and the Book deal view carries the bank's fee and schedule, so
 * the shell sends an outside party to the deal home from it.
 */
const DENIED_ROUTES = ['/deal-folder', '/skills', '/acquirers', '/book'];

/**
 * Step 7 — the scoped shell. ALLOWED_DESTINATIONS.external is the promise that
 * a counterparty never reaches the internal Deal Folder, the ranked Buyers, or
 * Skills. Nothing else renders that set in a real browser and checks it.
 */
export const assertScopedShell: Step = {
  name: 'assertScopedShell',

  async act(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertScopedShell');
    await page.goto(`/projects/${ctx.state.dealCode}/rail`);
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertScopedShell');
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });

    for (const label of OFFERED) {
      await expect(
        nav.getByRole('link', { name: label, exact: true }),
        `the invitee's rail does not offer ${label}`,
      ).toBeVisible();
    }
    for (const label of WITHHELD) {
      await expect(
        nav.getByRole('link', { name: label, exact: true }),
        `the invitee's rail offers ${label}, which is internal-only`,
      ).toHaveCount(0);
    }

    // Direct navigation is attempted and must not land: the shell bounces a
    // denied destination back to the deal home.
    for (const suffix of DENIED_ROUTES) {
      await page.goto(`/projects/${ctx.state.dealCode}${suffix}`);
      await expect(
        page,
        `the invitee landed on ${suffix}`,
      ).toHaveURL(new RegExp(`/projects/${ctx.state.dealCode}/?$`));
    }
  },

  async verify(ctx) {
    const page = requirePage(ctx.inviteePage, 'assertScopedShell');
    const response = await page.request.get('/api/v1/me');
    expect(response.status()).toBe(200);
    const me = (await response.json()) as {
      user: { email: string; status: string; is_external: boolean };
      memberships: Array<{ deal_code: string | null; deal_role: string; phase: number }>;
    };

    expect(me.user.email).toBe(ctx.state.directorEmail);
    expect(me.user.status, 'the invitee was not activated by acceptance').toBe('active');
    expect(me.user.is_external, 'the invitee is not flagged external').toBe(true);

    const membership = me.memberships.find(
      (seat) => seat.deal_code === ctx.state.dealCode,
    );
    expect(membership, 'the invitee has no seat on the deal').toBeTruthy();
    expect(membership?.deal_role).toBe('seller');
    // The phase the inviter confirmed on screen is the phase actually granted.
    expect(membership?.phase).toBe(ctx.state.inviteePhase);
  },
};
