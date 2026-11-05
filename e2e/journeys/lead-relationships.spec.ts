import { expect, test } from '../support/fixtures';
import { registerLead } from '../steps/registerLead';
import { addLeadRelationship } from '../steps/addLeadRelationship';
import { addLeadStakeholder } from '../steps/addLeadStakeholder';
import { assertLeadMapsPersist } from '../steps/assertLeadMapsPersist';
import { createDealFromLeadSearch } from '../steps/createDealFromLeadSearch';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

const JOURNEY: Step[] = [
  registerLead,
  addLeadRelationship,
  addLeadStakeholder,
  assertLeadMapsPersist,
  createDealFromLeadSearch,
];

test('the MD maps a lead and opens a mandate on it', async ({ page, evidence, runId, since }) => {
  const state: JourneyState = {};
  const ctx: JourneyContext = { page, evidence, runId, since, state };

  for (const step of JOURNEY) {
    await test.step(`${step.name} · act`, () => step.act(ctx));
    await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${step.name} · verify`, () => step.verify(ctx));
  }

  expect(state.dealCode, 'the journey produced no mandate on the mapped lead').toBeTruthy();
});
