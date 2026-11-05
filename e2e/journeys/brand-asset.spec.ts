import { request as playwrightRequest } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';

/**
 * The invitation email carries the brand mark as a raster served from the
 * application's own origin, so a mail client with no Conductia session must be
 * able to fetch it. The middleware matcher exempts `conductia/email/` for that
 * reason, and this is the only check that the exemption survives to a real
 * served response rather than only to the pattern.
 *
 * Both contexts declare an empty storageState explicitly. The `hermetic`
 * project sets use.storageState = MD_STATE_PATH, and an omitted option falls
 * back to it: a mail client carrying the MD's session would prove nothing here,
 * and an earlier revision of this spec did exactly that.
 */
const ANONYMOUS = { cookies: [], origins: [] };

test('serves the brand mark to a client with no session', async ({ baseURL }) => {
  const anonymous = await playwrightRequest.newContext({ baseURL, storageState: ANONYMOUS });
  try {
    const res = await anonymous.get('/conductia/email/conductia-mark-ink.png');

    expect(res.status(), 'a mail client could not fetch the brand mark').toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');

    const body = await res.body();
    expect([...body.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(body.length).toBeGreaterThan(0);
  } finally {
    await anonymous.dispose();
  }
});

test('a product route still guards a client with no session', async ({ browser, baseURL }) => {
  // The exemption must be the asset and nothing near it. Asserted the way
  // assertSignedOutRouteGuards asserts it: the guard lands the visitor on
  // sign-in, which is the observable behaviour, rather than a raw status code.
  const anonymous = await newCollectedContext(browser, { baseURL, storageState: ANONYMOUS });
  const page = await anonymous.newPage();
  try {
    await page.goto('/projects/PROJECT-X/team');
    await expect(page).toHaveURL(/\/sign-in\?redirectTo=/);
  } finally {
    await anonymous.close();
  }
});
