import { expect } from '@playwright/test';
import type { APIResponse, Page } from '@playwright/test';
import { requireEvidence, requirePage } from './types';
import type { Step } from './types';

/**
 * The deal-existence oracle is closed (decision-log D65). Runs on the second
 * seeded banker, who holds a seat on Project Northwind only: Project Atlas is a
 * real deal in her own tenant that she has no seat on, so probing its code must
 * read exactly like probing a code that was never issued.
 *
 * Deal codes follow CODENAME5-YYYY-NNN, so guessing the next one is trivial.
 * Only timing may differ between the two answers; that residual is accepted.
 */

/** scripts/seed-data.ts: Project Atlas, which the second banker is not seated on. */
const REAL_UNSEATED_CODE = 'ATLAS-2026-001';
/**
 * Never issued: the same codename and year, and the number 000, which neither
 * the seed nor mintDealCode (suffix 100-999) ever produces.
 */
const MADE_UP_CODE = 'ATLAS-2026-000';

/** Read probes, plus one write that must be refused before it touches anything. */
const PROBES: Array<{ method: 'GET' | 'PATCH'; path: (code: string) => string; body?: unknown }> = [
  { method: 'GET', path: (code) => `/api/v1/deals/${code}` },
  { method: 'GET', path: (code) => `/api/v1/deals/${code}/audit` },
  { method: 'GET', path: (code) => `/api/v1/deals/${code}/documents` },
  { method: 'GET', path: (code) => `/api/v1/deals/${code}/members` },
  { method: 'GET', path: (code) => `/api/v1/deals/${code}/rail` },
  { method: 'GET', path: (code) => `/api/v1/deals/${code}/steps` },
  { method: 'PATCH', path: (code) => `/api/v1/deals/${code}/progress`, body: { currentStepSeq: 2 } },
];

/** `date` is the one header that varies per response. */
async function answer(response: APIResponse) {
  const headers = Object.entries(response.headers())
    .filter(([name]) => name !== 'date')
    .sort(([a], [b]) => a.localeCompare(b));
  return { status: response.status(), body: await response.text(), headers };
}

async function expectMissingDealPage(page: Page, code: string) {
  await page.goto(`/projects/${encodeURIComponent(code)}/data-room`);
  // One state for both: the shared not-on-deal copy, never a seat problem.
  await expect(
    page.getByText('You are not on this deal.'),
    `${code} does not read as a deal the viewer is not on`,
  ).toBeVisible();
  await expect(page.getByText('Your seat does not cover this deal')).toHaveCount(0);
}

export const assertDealNotVisibleToUnseated: Step = {
  name: 'assertDealNotVisibleToUnseated',

  async act(ctx) {
    const page = requirePage(ctx.secondPage, 'assertDealNotVisibleToUnseated');
    await page.goto(`/projects/${encodeURIComponent(REAL_UNSEATED_CODE)}/data-room`);
  },

  async assertUi(ctx) {
    const page = requirePage(ctx.secondPage, 'assertDealNotVisibleToUnseated');
    await expectMissingDealPage(page, REAL_UNSEATED_CODE);
    await expectMissingDealPage(page, MADE_UP_CODE);
  },

  async verify(ctx) {
    const evidence = requireEvidence(ctx.secondEvidence, 'assertDealNotVisibleToUnseated');

    for (const probe of PROBES) {
      const send = (code: string) =>
        evidence.request.fetch(probe.path(code), {
          method: probe.method,
          ...(probe.body === undefined ? {} : { data: probe.body }),
        });
      const real = await answer(await send(REAL_UNSEATED_CODE));
      const madeUp = await answer(await send(MADE_UP_CODE));

      const label = `${probe.method} ${probe.path('{code}')}`;
      expect(madeUp.status, `${label}: the made-up code is not a 404`).toBe(404);
      expect(real, `${label}: an unseated probe tells a real deal from a made-up one`).toEqual(
        madeUp,
      );
    }
  },
};
