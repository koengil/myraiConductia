import { request as playwrightRequest } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { newCollectedContext } from '../support/cspViolations';
import { registerLead } from '../steps/registerLead';
import { createDeal } from '../steps/createDeal';
import { uploadToDealFolder } from '../steps/uploadToDealFolder';
import { uploadToDataRoom } from '../steps/uploadToDataRoom';
import { grantExternalSeat } from '../steps/grantExternalSeat';
import { assertExternalRoomWall } from '../steps/assertExternalRoomWall';
import { assertOpeningRecordsNothing } from '../steps/assertOpeningRecordsNothing';
import { downloadFromDataRoom } from '../steps/downloadFromDataRoom';
import { assertDocumentAuditTrail } from '../steps/assertDocumentAuditTrail';
import { EXTERNAL_STATE_PATH } from '../auth/session';
import { Evidence } from '../support/evidence';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

const JOURNEY: Step[] = [
  registerLead,
  createDeal,
  uploadToDealFolder,
  uploadToDataRoom,
  grantExternalSeat,
  assertExternalRoomWall,
  assertOpeningRecordsNothing,
  downloadFromDataRoom,
  assertDocumentAuditTrail,
];

test('the data room wall', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  test.skip(
    testInfo.project.name === 'live',
    'the counterparty is a seeded local account; a deployed environment carries no guaranteed external seat holder',
  );

  const state: JourneyState = {};

  const externalContext = await newCollectedContext(browser, {
    storageState: EXTERNAL_STATE_PATH,
    baseURL,
  });
  const externalPage = await externalContext.newPage();
  const externalApi = await playwrightRequest.newContext({
    baseURL,
    storageState: EXTERNAL_STATE_PATH,
  });

  const ctx: JourneyContext = {
    page,
    evidence,
    externalPage,
    externalEvidence: new Evidence(externalApi),
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
    expect(state.dealFolderDocumentId, 'the journey filed no internal document').toBeTruthy();
  } finally {
    await externalApi.dispose();
    await externalContext.close();
  }
});
