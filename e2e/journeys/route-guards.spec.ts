import { request as playwrightRequest } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { assertSignedOutRouteGuards } from '../steps/assertSignedOutRouteGuards';
import { openProfileFromShell } from '../steps/openProfileFromShell';
import { assertProfileIsNotFixtureData } from '../steps/assertProfileIsNotFixtureData';
import { assertDealNotVisibleToUnseated } from '../steps/assertDealNotVisibleToUnseated';
import { signOutFromShell } from '../steps/signOutFromShell';
import { SECOND_BANKER_EMAIL, SECOND_BANKER_STATE_PATH, mintSeededSession } from '../auth/session';
import { Evidence } from '../support/evidence';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The perimeter half needs only the anonymous context and the MD session the
 * setup project already mints, so it runs under `live` too. The second half
 * needs a THIRD seeded account, and e2e/auth/setup.ts's admin mint records why
 * that must not run against a deployed target: the suite controls neither that
 * account's existence nor its password there, and a mismatch would fail the
 * spec before a single perimeter assertion ran.
 */
const PERIMETER: Step[] = [assertSignedOutRouteGuards, openProfileFromShell];
// The second banker holds no seat on Project Atlas, so she is also the probe
// for the deal-existence oracle (decision-log D65), before she signs out.
const SECOND_IDENTITY: Step[] = [
  assertProfileIsNotFixtureData,
  assertDealNotVisibleToUnseated,
  signOutFromShell,
];

const liveTarget = Boolean(process.env.E2E_BASE_URL);
const JOURNEY: Step[] = liveTarget ? PERIMETER : [...PERIMETER, ...SECOND_IDENTITY];

test('route guards, session and profile identity', async ({
  page,
  evidence,
  runId,
  since,
  browser,
  baseURL,
}) => {
  const state: JourneyState = {};

  // No storage state, and said so explicitly: the `hermetic` project sets
  // use.storageState = MD_STATE_PATH, which a new browser context falls back to
  // whenever the option is omitted. An omitted option here would hand the
  // signed-out perimeter a live MD session.
  const anonymousContext = await newCollectedContext(browser, {
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const anonymousPage = await anonymousContext.newPage();

  const ctx: JourneyContext = {
    page,
    evidence,
    anonymousPage,
    runId,
    since,
    state,
  };

  const disposables: Array<() => Promise<void>> = [() => anonymousContext.close()];

  if (!liveTarget) {
    // The second identity is minted here rather than in the setup project: it
    // is this journey's alone, and setup's mints are dependencies of every spec.
    await mintSeededSession(SECOND_BANKER_EMAIL, SECOND_BANKER_STATE_PATH, baseURL);
    const secondContext = await newCollectedContext(browser, {
      baseURL,
      storageState: SECOND_BANKER_STATE_PATH,
    });
    const secondApi = await playwrightRequest.newContext({
      baseURL,
      storageState: SECOND_BANKER_STATE_PATH,
    });
    disposables.unshift(() => secondContext.close(), () => secondApi.dispose());

    ctx.secondPage = await secondContext.newPage();
    ctx.secondEvidence = new Evidence(secondApi);
  }

  try {
    for (const step of JOURNEY) {
      await test.step(`${step.name} · act`, () => step.act(ctx));
      await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
      await test.step(`${step.name} · verify`, () => step.verify(ctx));
    }
    expect(state.mdFullName, 'the journey never read the MD identity').toBeTruthy();
  } finally {
    for (const dispose of disposables) await dispose();
  }
});
