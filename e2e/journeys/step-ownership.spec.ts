import { request as playwrightRequest } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { registerLead } from '../steps/registerLead';
import { createDeal } from '../steps/createDeal';
import { openRail } from '../steps/openRail';
import { grantMemberSeat } from '../steps/grantMemberSeat';
import { assignStepToMember } from '../steps/assignStepToMember';
import { memberSavesAssignedStep } from '../steps/memberSavesAssignedStep';
import { memberCompletesAssignedStep } from '../steps/memberCompletesAssignedStep';
import { memberReadsCompletedStep } from '../steps/memberReadsCompletedStep';
import { memberBlockedOnOtherStep } from '../steps/memberBlockedOnOtherStep';
import { memberSavesUnassignedStep } from '../steps/memberSavesUnassignedStep';
import { MEMBER_STATE_PATH } from '../auth/session';
import { Evidence } from '../support/evidence';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * Step ownership across two identities: the MD hands a rail step to a seated
 * bank member, who works and completes it, and is refused — on screen and at
 * the API — on a step somebody else owns.
 */
const JOURNEY: Step[] = [
  registerLead,
  createDeal,
  openRail,
  grantMemberSeat,
  assignStepToMember,
  memberSavesAssignedStep,
  memberCompletesAssignedStep,
  memberReadsCompletedStep,
  memberBlockedOnOtherStep,
  memberSavesUnassignedStep,
];

test('deal rail step ownership', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  // Hermetic-only, for the same reason the firm-admin identity is minted only
  // there: the member's session comes from a seeded account and SEED_PASSWORD,
  // neither of which this suite controls on a deployed environment.
  test.skip(
    testInfo.project.name === 'live',
    'the bank-member identity is a local seed; a deployed environment owns its own accounts',
  );
  // Ten steps across two identities run ~85–95s on the CI runner, right at
  // the 90s default: every step passed and the journey still timed out
  // (PR #150). Triple the budget, as invite-rotation does.
  test.slow();

  const state: JourneyState = {};

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
    expect(state.memberId, 'the journey seated no member').toBeTruthy();
  } finally {
    await memberApi.dispose();
    await memberContext.close();
  }
});
