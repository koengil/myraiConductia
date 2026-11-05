// Deliberately the plain Playwright `test`, not ../support/fixtures: this spec
// renders a blocked resource ON PURPOSE and asserts the collector recorded it,
// which the failing fixture would turn into a test failure. It installs the
// collector by hand and says so. Every other spec uses the fixture.
import { expect, test } from '@playwright/test';
import {
  cspViolations,
  flushCspReports,
  newCollectedContext,
  takeRegisteredContexts,
  withCspCollector,
} from '../support/cspViolations';

/**
 * Regression for the collector itself. A violation reported on page 1 must
 * still be on the list after a full navigation to page 2. An in-page buffer is
 * per document and would lose it; the list lives in Node, and this is the
 * check that keeps it there.
 */
test('a violation on page 1 survives navigation to page 2', async ({ context, page }) => {
  await withCspCollector(context);

  await page.goto('/terms');
  // Resolves on the violation event itself. The collector's listener was
  // registered first, so by now the report is already on its way to Node.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        document.addEventListener('securitypolicyviolation', () => resolve(), { once: true });
        const img = document.createElement('img');
        img.src = 'https://blocked.example/p.png';
        document.body.append(img);
      }),
  );

  // A full navigation to a clean page: a new document, so any in-page buffer is gone.
  await page.goto('/sign-in');

  await expect.poll(() => cspViolations(context).length).toBe(1);
  const [violation] = cspViolations(context);
  expect(violation.directive).toBe('img-src');
  expect(violation.blockedURI).toContain('blocked.example');
  expect(violation.page).toContain('/terms');
});

/**
 * Regression for late reports. The violation is raised after the spec's last
 * action has returned, the way a late render can raise one just before the end. A single flush
 * must put it on the list with no polling, which is what teardown relies on.
 */
test('a report raised just before teardown is on the list after one flush', async ({ context, page }) => {
  await withCspCollector(context);
  await page.goto('/terms');

  // Raised after the spec's last action has returned, as a late render would.
  await page.evaluate(() => {
    setTimeout(() => {
      const img = document.createElement('img');
      img.src = 'https://late.example/p.png';
      document.body.append(img);
    }, 20);
  });
  await flushCspReports(context);

  expect(cspViolations(context).map((v) => v.blockedURI)).toEqual([
    expect.stringContaining('late.example'),
  ]);
});

/**
 * Specs close their extra contexts before teardown reads them. Closing a
 * collected context flushes first, so a report raised just before the close is
 * still counted. Playwright's own close happens to give a 20 ms timer time to
 * report, so this pins the behaviour rather than discriminating the flush; the
 * test above is the one that fails without it.
 */
test('closing a collected context keeps a report raised just before it', async ({ browser, baseURL }) => {
  const extra = await newCollectedContext(browser, { baseURL });
  // Not asserted by the fixture here: this spec uses the plain `test`.
  takeRegisteredContexts();
  const page = await extra.newPage();
  await page.goto('/terms');

  // Raised after the spec's last action has returned, as a late render would.
  await page.evaluate(() => {
    setTimeout(() => {
      const img = document.createElement('img');
      img.src = 'https://closing.example/p.png';
      document.body.append(img);
    }, 20);
  });
  await extra.close();

  expect(cspViolations(extra).map((v) => v.blockedURI)).toEqual([
    expect.stringContaining('closing.example'),
  ]);
});
