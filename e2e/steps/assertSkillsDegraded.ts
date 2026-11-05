import { expect, type ConsoleMessage, type Page } from '@playwright/test';
import {
  SKILL_LIBRARY_UNAVAILABLE_MESSAGE,
  SKILL_SERVICE_UNCONFIGURED_MESSAGE,
} from '@/lib/ignatious/failure';
import { expectSingleComplianceInstrument } from '../support/selectors';
import type { Step } from './types';

/**
 * console.error entries captured while this step's listener is attached,
 * keyed by page. A Playwright console-event handler that throws does not fail
 * the test — the throw escapes as an unhandled rejection outside the
 * assertion flow. Collecting into this array and asserting it is empty in
 * verify() makes the same claim actually enforced.
 */
const collectedConsoleErrors = new WeakMap<Page, string[]>();
/** The listener's own removal, so verify() can detach it before this step ends. */
const detachConsoleListener = new WeakMap<Page, () => void>();

/**
 * D6's claim is "no console.error escapes", full stop — not "no console.error
 * that happens to mention Ignatious". An allow-list keyed on Ignatious/bench
 * keywords would let a genuine rendering crash on this surface (e.g. a
 * TypeError from malformed bench data, or a minified React production error
 * with its component name stripped) pass silently, exactly where this step
 * is pointed. So this is a deny-list: every console.error fails the step
 * EXCEPT the known, pre-existing, unrelated messages below, each excluded by
 * its specific text -- never by a broad pattern.
 *
 * - `[Skills route] failed to load skills` -- SkillsPage
 *   (src/app/(authed)/projects/[projectId]/skills/page.tsx) logs this when
 *   its own `getApi().getSkills()` call fails; it is a distinct code path
 *   from the Ignatious bench (BenchCatalog) this step asserts on, and D6
 *   makes no claim about it.
 * - `Failed to load resource: the server responded with a status of 503
 *   (Service Unavailable)` -- Chrome's own devtools network log for ANY
 *   failed fetch/XHR, emitted automatically for the page's real
 *   `listBenchSkills()` call to `/api/v1/bench/skills` when it hits the
 *   intentional 503 this step exists to assert. It is the browser's network
 *   log, not an application-level error, and it is the direct, expected
 *   byproduct of exercising the degraded path under test -- excluding it
 *   does not weaken the claim, since it would fire on every correct degraded
 *   page load regardless of how the app handles the failure.
 */
const KNOWN_UNRELATED_CONSOLE_ERRORS = [
  '[Skills route] failed to load skills',
  'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
];

function isKnownUnrelated(text: string): boolean {
  return KNOWN_UNRELATED_CONSOLE_ERRORS.some((known) => text.includes(known));
}

/**
 * D6 — the hermetic tier does not configure Ignatious and does not stub it. The
 * degraded path is real behavior the beta can hit when credentials lapse, so it
 * is asserted as a first-class outcome: the surface renders, the unconfigured
 * message is visible, nothing throws, and no console.error escapes. Real skill
 * execution is live-tier only.
 */
export const assertSkillsDegraded: Step = {
  name: 'assertSkillsDegraded',

  async act(ctx) {
    // Live tier: Ignatious IS configured there, so this step asserts nothing.
    if (process.env.E2E_BASE_URL) return;

    const errors: string[] = [];
    collectedConsoleErrors.set(ctx.page, errors);
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === 'error' && !isKnownUnrelated(message.text())) {
        errors.push(message.text());
      }
    };
    ctx.page.on('console', onConsole);
    // Scoped to this step: detached in verify() so it cannot leak into the
    // console output of later steps' pages.
    detachConsoleListener.set(ctx.page, () => ctx.page.off('console', onConsole));

    await ctx.page.goto(`/projects/${encodeURIComponent(ctx.state.dealCode as string)}/skills`);
  },

  async assertUi(ctx) {
    if (process.env.E2E_BASE_URL) return;
    const bench = ctx.page.getByRole('region', { name: 'Ignatious skill bench' });
    await expect(bench).toBeVisible();
    await expect(bench.getByText(SKILL_LIBRARY_UNAVAILABLE_MESSAGE)).toBeVisible();
  },

  async verify(ctx) {
    if (process.env.E2E_BASE_URL) return;

    detachConsoleListener.get(ctx.page)?.();

    const errors = collectedConsoleErrors.get(ctx.page) ?? [];
    expect(
      errors,
      `console.error escaped the skills surface: ${errors.join('; ')}`,
    ).toEqual([]);

    const response = await ctx.page.request.get('/api/v1/bench/skills');
    expect(response.status(), 'the unconfigured bench must degrade, not throw').toBe(503);
    expect((await response.json()).error).toBe(SKILL_SERVICE_UNCONFIGURED_MESSAGE);

    await expectSingleComplianceInstrument(ctx.page);
  },
};
