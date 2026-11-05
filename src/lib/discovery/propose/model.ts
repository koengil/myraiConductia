// Demo-only (#460): the deal proposal step's model. Delete this folder when #459 lands.
//
// Bake-off A's best ZDR arm (#437, run bakeoff-r1, 2026-10-09). The id is pinned
// here, not read from the environment, so a deploy cannot change which model reads
// unrouted mail. It deliberately does not go through resolveExtractModel, whose
// verified path admits only the extractor's Sonnet 5 pin.

import { ProcessorRefusedError } from '@/lib/modelGateway/processorGate';

export const PROPOSAL_MODEL = 'anthropic/claude-haiku-5.5';

/** ADR-0017 bars Covered Models for bank content (the same rule as processorGate.ts). */
const COVERED_MODEL = /fable|mythos/i;

/** The model a proposal call uses; refuses a Covered Model, so a later edit of the pin cannot reach one. */
export function resolveProposalModel(model: string = PROPOSAL_MODEL): string {
  if (COVERED_MODEL.test(model)) throw new ProcessorRefusedError('covered_model');
  return model;
}
