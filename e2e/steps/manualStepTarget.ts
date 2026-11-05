import { MVP_DEAL_RAIL, orderedSteps, stepBySeq, type RailStep } from '@/lib/rail/dealRail';
import { manualStepDef, type ManualStepDef } from '@/lib/rail/manualStepDefs';

export const MANUAL_STEP_SEQ = 10;
export const UPLOAD_STEP_SEQ = 18;

const MVP_STEPS = orderedSteps(MVP_DEAL_RAIL);

function railStep(seq: number): RailStep {
  const step = stepBySeq(seq, MVP_DEAL_RAIL);
  if (!step) throw new Error(`no MVP rail step at seq ${seq}`);
  return step;
}

function nextRailStep(step: RailStep): RailStep {
  const next = MVP_STEPS[MVP_STEPS.findIndex((s) => s.id === step.id) + 1];
  if (!next) throw new Error(`${step.id} is the last step on the MVP rail`);
  return next;
}

export function manualDef(stepId: string): ManualStepDef {
  const def = manualStepDef(stepId);
  if (!def) throw new Error(`${stepId} carries no manual step definition`);
  return def;
}

export const MANUAL_STEP = railStep(MANUAL_STEP_SEQ);
export const UPLOAD_STEP = railStep(UPLOAD_STEP_SEQ);
export const SKIP_STEP = nextRailStep(MANUAL_STEP);
export const STEP_AFTER_SKIP = nextRailStep(SKIP_STEP);
