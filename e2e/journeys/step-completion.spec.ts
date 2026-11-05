import { test } from '../support/fixtures';
import { registerLead } from '../steps/registerLead';
import { createDeal } from '../steps/createDeal';
import { openRail } from '../steps/openRail';
import { advanceRail } from '../steps/advanceRail';
import { advanceCursorToManualStep } from '../steps/advanceCursorToManualStep';
import { refuseIncompleteStep } from '../steps/refuseIncompleteStep';
import { saveStepProgress } from '../steps/saveStepProgress';
import { completeManualStep } from '../steps/completeManualStep';
import { fileStepArtifact } from '../steps/fileStepArtifact';
import { skipStepAtCursor } from '../steps/skipStepAtCursor';
import { assertStepAudit } from '../steps/assertStepAudit';
import { assertInMotionNamesNextStep } from '../steps/assertInMotionNamesNextStep';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * Bug bash case 5 — complete with proof, skip with reason: the MD works a
 * manual rail step to done, is refused while a required field is empty, skips
 * the next step with a logged approver and reason, and reads both back on
 * the audit trail and the Conductor Center.
 */
const JOURNEY: Step[] = [
  registerLead,
  createDeal,
  openRail,
  advanceRail,
  advanceCursorToManualStep,
  refuseIncompleteStep,
  saveStepProgress,
  completeManualStep,
  fileStepArtifact,
  skipStepAtCursor,
  assertStepAudit,
  assertInMotionNamesNextStep,
];

test('the MD completes a step with proof and skips one with a reason', async ({
  page,
  evidence,
  runId,
  since,
}) => {
  const state: JourneyState = {};
  const ctx: JourneyContext = { page, evidence, runId, since, state };

  for (const step of JOURNEY) {
    await test.step(`${step.name} · act`, () => step.act(ctx));
    await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${step.name} · verify`, () => step.verify(ctx));
  }
});

// The skip approver and reason are read back from the deal record inside
// skipStepAtCursor.verify (GET /steps/{id}: status skipped, completionNote).
