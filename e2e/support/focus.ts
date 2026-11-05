import type { Page } from '@playwright/test';

/**
 * Headless Chromium never fires window focus or visibilitychange: bringToFront,
 * Page.setWebLifecycleState and a second tab in the same context all leave them
 * unfired. The product's live-permission revalidation listens on exactly those
 * events, so the suite dispatches them. Only the environment signal is
 * substituted; the assertions around it are unchanged.
 */
export async function refocusTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}
