// Demo-only (#460): the station a model proposal points at, and the sentence that says why. Delete this file with the
// proposal step when #459 lands.
//
// Pure and model-free, like group.ts: the Accept dialog, the deal page and the Set station dialog all print the same
// station and the same reason, and neither depends on a message. The reason is a fixed template over three numbers.

import { MVP_DEAL_RAIL } from '@/lib/rail/dealRail';

import type { ProposalPhase } from './group';

const phaseNumber = (phase: ProposalPhase): number => Number(phase.slice('phase-'.length));

/**
 * The step the model proposes for a deal whose highest phase is `phase`: the phase's first step on the MVP rail with
 * a canonical seq of 1 or more. Gate 0's notify step has seq 0 and is no station a proposal can name.
 */
export function proposedStepFor(phase: ProposalPhase): string {
  const step = MVP_DEAL_RAIL.find((p) => p.index === phaseNumber(phase))?.steps.find((s) => s.seq >= 1);
  if (!step) throw new Error(`The rail has no step for ${phase}`);
  return step.id;
}

/**
 * "The model placed 3 of 4 emails in Phase 2 · Preparation & Market Readiness": how many of the deal's emails the
 * model put in the proposed phase. Carries no name, subject or address.
 */
export function proposalReason({ placed, of, phase }: { placed: number; of: number; phase: ProposalPhase }): string {
  const railPhase = MVP_DEAL_RAIL.find((p) => p.index === phaseNumber(phase));
  const label = railPhase ? `Phase ${railPhase.index} · ${railPhase.name}` : `Phase ${phaseNumber(phase)}`;
  return `The model placed ${placed} of ${of} ${of === 1 ? 'email' : 'emails'} in ${label}`;
}
