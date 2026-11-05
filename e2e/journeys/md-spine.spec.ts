import { expect, test } from '../support/fixtures';
import { registerLead } from '../steps/registerLead';
import { createDeal, createDealEnteringAt } from '../steps/createDeal';
import { openRail } from '../steps/openRail';
import { assertSkillsDegraded } from '../steps/assertSkillsDegraded';
import { uploadToDataRoom } from '../steps/uploadToDataRoom';
import { composeAndSendMail } from '../steps/composeAndSendMail';
import { advanceRail } from '../steps/advanceRail';
import { closeDealInBook } from '../steps/closeDealInBook';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The MD spine, single identity: lead -> mandate -> rail -> data room -> mail
 * -> advance. Project-agnostic on purpose: the same file runs under the
 * hermetic and the live project (design D1).
 */
const SPINE: Step[] = [
  registerLead,
  createDeal,
  openRail,
  assertSkillsDegraded,
  uploadToDataRoom,
  composeAndSendMail,
  advanceRail,
];

test('the MD spine', async ({ page, evidence, runId, since }) => {
  const state: JourneyState = {};
  const ctx: JourneyContext = { page, evidence, runId, since, state };

  for (const step of SPINE) {
    await test.step(`${step.name} · act`, () => step.act(ctx));
    await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${step.name} · verify`, () => step.verify(ctx));
  }

  expect(state.leadCompanyId, 'the journey produced no lead').toBeTruthy();
});

const CLOSE: Step[] = [
  registerLead,
  createDealEnteringAt('22 · Mandate Activation Checklist'),
  closeDealInBook,
];

test('the MD closes the deal and the transition is audited', async ({ page, evidence, runId, since }) => {
  const ctx: JourneyContext = { page, evidence, runId, since, state: {} };

  for (const step of CLOSE) {
    await test.step(`${step.name} · act`, () => step.act(ctx));
    await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${step.name} · verify`, () => step.verify(ctx));
  }
});
