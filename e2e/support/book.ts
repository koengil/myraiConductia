import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Storm's lifecycle taxonomy, frozen: the exact wording AND the exact order
 * the Book groups deals in. Hardcoded rather than imported from
 * `src/lib/constants/deals`, because importing the list the product renders
 * from would let a reordering pass unnoticed. "Uncategorized" is the Book's
 * own catch-all for a row outside the seven.
 */
export const BOOK_SECTIONS = [
  'Live deals',
  'Pitches',
  'Prospects and client maintenance',
  'Mandate hold',
  'Terminated',
  'Closed',
  'Lost',
  'Uncategorized',
] as const;

/**
 * Switch the bank home to the Book. The click is retried rather than fired
 * once: the pill is server-rendered, so a click can land before React has
 * hydrated it and be lost with no visible trace. aria-checked is the switch's
 * own readout of which view won.
 */
export async function openBookView(page: Page): Promise<void> {
  const pill = page.getByRole('radiogroup', { name: 'View' }).getByRole('radio', { name: 'Book' });
  await expect(async () => {
    await pill.click();
    await expect(pill).toHaveAttribute('aria-checked', 'true', { timeout: 2_000 });
  }).toPass();
}

/** One lifecycle section's table, addressed by the heading that names it. */
export function bookTable(page: Page, section: string): Locator {
  return page.getByRole('table', { name: section });
}

/**
 * The sections on screen, in the order they render. Only the non-empty ones
 * are rendered, so the assertion is relative: whatever is present must appear
 * in the canonical order, spelled the canonical way.
 */
export async function expectBookSectionOrder(page: Page): Promise<string[]> {
  const known = BOOK_SECTIONS as readonly string[];
  const headings = await page.getByRole('heading', { level: 2 }).allInnerTexts();
  const shown = headings.map((text) => text.trim()).filter((text) => known.includes(text));
  expect(shown.length, 'the Book rendered no lifecycle section').toBeGreaterThan(0);
  expect(shown).toEqual(known.filter((section) => shown.includes(section)));
  return shown;
}
