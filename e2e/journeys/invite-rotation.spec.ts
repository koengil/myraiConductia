import { request as playwrightRequest } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { registerLead } from '../steps/registerLead';
import { createDealWithColleagueInvite } from '../steps/createDealWithColleagueInvite';
import { inviteExternalDirector } from '../steps/inviteExternalDirector';
import { readInviteMail } from '../steps/readInviteMail';
import { resendInvite } from '../steps/resendInvite';
import { readRotatedInviteMail } from '../steps/readRotatedInviteMail';
import { assertPreviousCodeRejected } from '../steps/assertPreviousCodeRejected';
import { revokeInvite } from '../steps/revokeInvite';
import { assertRevokedInviteDeadEnds } from '../steps/assertRevokedInviteDeadEnds';
import { reinviteExternalDirector } from '../steps/reinviteExternalDirector';
import { readReissuedInviteMail } from '../steps/readReissuedInviteMail';
import { assertReissuedLinkOpensAcceptance } from '../steps/assertReissuedLinkOpensAcceptance';
import { ADMIN_STATE_PATH } from '../auth/session';
import { Evidence } from '../support/evidence';
import { writeTeardownManifest } from '../support/teardownManifest';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The invitation lifecycle after it is sent: resend rotates the credential,
 * revoke closes it with an honest dead-end, and a re-invitation reopens it.
 * Acceptance, MFA enrollment and the scoped shell are the invite-onboarding
 * journey's subject and are not repeated here.
 *
 * Hermetic-only for the same reason that journey is: invite delivery is real
 * Resend called server-side, terminated in-suite by e2e/support/mailStub.ts,
 * so there is nothing to read back against a deployed environment.
 */
const JOURNEY: Step[] = [
  registerLead,
  createDealWithColleagueInvite,
  inviteExternalDirector,
  readInviteMail,
  resendInvite,
  readRotatedInviteMail,
  assertPreviousCodeRejected,
  revokeInvite,
  assertRevokedInviteDeadEnds,
  reinviteExternalDirector,
  readReissuedInviteMail,
  assertReissuedLinkOpensAcceptance,
];

test('the invite rotation journey', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  test.skip(
    testInfo.project.name === 'live',
    'invite delivery is stubbed in-suite; there is nothing to assert against a deployed environment',
  );
  test.slow();

  const state: JourneyState = {};

  const adminContext = await newCollectedContext(browser, { storageState: ADMIN_STATE_PATH, baseURL });
  const adminPage = await adminContext.newPage();
  const adminApi = await playwrightRequest.newContext({
    baseURL,
    storageState: ADMIN_STATE_PATH,
  });

  // No storage state, deliberately: every session this context holds is one
  // the emailed credential produced. The empty value is explicit because the
  // project default would otherwise hand the invitee the MD's own session.
  const inviteeContext = await newCollectedContext(browser, {
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const inviteePage = await inviteeContext.newPage();

  const ctx: JourneyContext = {
    page,
    evidence,
    adminPage,
    adminEvidence: new Evidence(adminApi),
    inviteePage,
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
    expect(state.dealCode, 'the journey produced no deal').toBeTruthy();

    writeTeardownManifest([state.colleagueEmail, state.directorEmail]);
  } finally {
    await adminApi.dispose();
    await adminContext.close();
    await inviteeContext.close();
  }
});
