import { request as playwrightRequest } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { registerLead } from '../steps/registerLead';
import { createDeal } from '../steps/createDeal';
import { openBookHome } from '../steps/openBookHome';
import { setBookFields } from '../steps/setBookFields';
import { assertBookFieldsPersist } from '../steps/assertBookFieldsPersist';
import { assertDealMovedInBook } from '../steps/assertDealMovedInBook';
import { grantDealSeat } from '../steps/grantDealSeat';
import { assertMemberBookReadOnly } from '../steps/assertMemberBookReadOnly';
import { MEMBER_STATE_PATH } from '../auth/session';
import { Evidence } from '../support/evidence';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The Book journey (bug bash case 13): the whole book in view, the four
 * graduated fields set and read back, and the member who may only read them.
 *
 * Hermetic-only, like the invite journey and for a comparable reason: the
 * second identity is a SEEDED local account (e2e/auth/session.ts), and a
 * deployed environment neither guarantees that account exists nor that its
 * password is the suite's. The MD half would run anywhere; splitting the
 * journey to buy that would trade a real end-to-end proof for a partial one.
 */
const JOURNEY: Step[] = [
  registerLead,
  createDeal,
  openBookHome,
  setBookFields,
  assertBookFieldsPersist,
  assertDealMovedInBook,
  grantDealSeat,
  assertMemberBookReadOnly,
];

test('the Book journey', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  test.skip(
    testInfo.project.name === 'live',
    'the member identity is a seeded local account; there is nothing to sign in as on a deployed environment',
  );

  const state: JourneyState = {};

  // The bank member gets their own context, so neither session's cookies can
  // leak into the other's page.
  const memberContext = await newCollectedContext(browser, { storageState: MEMBER_STATE_PATH, baseURL });
  const memberPage = await memberContext.newPage();
  const memberApi = await playwrightRequest.newContext({
    baseURL,
    storageState: MEMBER_STATE_PATH,
  });

  const ctx: JourneyContext = {
    page,
    evidence,
    memberPage,
    memberEvidence: new Evidence(memberApi),
    runId,
    since,
    state,
  };

  try {
    for (const step of JOURNEY) {
      await test.step(`${step.name} · act`, () => step.act(ctx));
      await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
      await test.step(`${step.name} · verify`, () => step.verify(ctx));
    }

    expect(state.dealCode, 'the journey opened no mandate').toBeTruthy();
  } finally {
    await memberApi.dispose();
    await memberContext.close();
  }
});
