import { request as playwrightRequest } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { addSentRecipient } from '../steps/addSentRecipient';
import { registerLead } from '../steps/registerLead';
import { createDealWithColleagueInvite } from '../steps/createDealWithColleagueInvite';
import { inviteExternalDirector } from '../steps/inviteExternalDirector';
import { readInviteMail } from '../steps/readInviteMail';
import { acceptInvite } from '../steps/acceptInvite';
import { enrolMfa } from '../steps/enrolMfa';
import { assertScopedShell } from '../steps/assertScopedShell';
import { assertRosterReflectsAcceptance } from '../steps/assertRosterReflectsAcceptance';
import { ADMIN_STATE_PATH } from '../auth/session';
import { Evidence } from '../support/evidence';
import { writeTeardownManifest } from '../support/teardownManifest';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The multi-identity onboarding journey: a firm invites an external director,
 * who receives mail, verifies, enrols, accepts, and lands in a scoped shell.
 *
 * Hermetic-only, unlike the MD spine. Real invite delivery cannot be read back
 * by a test (design D7): it is Resend called server-side by raw fetch, with no
 * outbox row and no Inbucket delivery. The suite terminates the send itself, so
 * this journey is meaningless against a deployed environment.
 */
const JOURNEY: Step[] = [
  registerLead,
  createDealWithColleagueInvite,
  inviteExternalDirector,
  readInviteMail,
  acceptInvite,
  enrolMfa,
  assertScopedShell,
  assertRosterReflectsAcceptance,
  addSentRecipient,
];

test('the invite onboarding journey', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  // The first journey to bend D1's project-agnostic rule, and it bends because
  // real delivery genuinely cannot be read back by a test (design D7): the
  // suite terminates the Resend call itself. Skipped, not failed, under live.
  test.skip(
    testInfo.project.name === 'live',
    'invite delivery is stubbed in-suite; there is nothing to assert against a deployed environment',
  );

  const state: JourneyState = {};

  // The firm admin, for the one company-management act the journey needs
  // (see inviteExternalDirector). Its own context, so neither session's
  // cookies can leak into the other's page.
  const adminContext = await newCollectedContext(browser, { storageState: ADMIN_STATE_PATH, baseURL });
  const adminPage = await adminContext.newPage();
  const adminApi = await playwrightRequest.newContext({
    baseURL,
    storageState: ADMIN_STATE_PATH,
  });

  // The second identity. No storage state, deliberately: the invitee's session
  // is the thing this journey proves, so it must come from the action link.
  // The empty storageState is explicit, not incidental: the "hermetic"
  // project sets use.storageState = MD_STATE_PATH, and a browser context
  // falls back to that project default whenever the option is omitted. An
  // omitted option here would silently hand the invitee the MD's own
  // session, defeating the entire point of this context.
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

    // A passing run leaves nothing behind; a failing one leaves everything.
    // The manifest is written HERE, after the last assertion, so it exists
    // only on success — and a failed run is exactly when the rows matter,
    // because the trace refers to them and reading the invite row is often how
    // the failure is diagnosed (design D12).
    writeTeardownManifest([state.colleagueEmail, state.directorEmail, state.recipientEmail]);
  } finally {
    await adminApi.dispose();
    await adminContext.close();
    await inviteeContext.close();
  }
});
