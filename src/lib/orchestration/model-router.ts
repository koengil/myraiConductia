// Model routing + token metering (kickoff #7).
//
// Routing lives in the orchestrator and is decided by importance, not cost:
// external-facing output runs on the highest-quality tier; internal tasks run
// on cheaper tiers. Token spend per user / deal / agent is a first-class metric
// from day one — the meter is stubbed (agents return canned counts) but every
// spend event is emitted so the real meter drops in later with no spine change.

import type { ModelTier, Stakes } from './types';

export type WorkflowStep = 'research' | 'draft' | 'screen';

/**
 * The draft step produces the artifact that leaves the firm, so a high-stakes
 * draft routes to the frontier tier. Research is internal and routes cheap.
 */
export function selectModel(input: { step: WorkflowStep; stakes: Stakes }): ModelTier {
  if (input.step === 'research') return 'economy';
  if (input.step === 'draft') return input.stakes === 'high' ? 'frontier' : 'standard';
  return 'standard';
}

export type TokenSpend = {
  agent: string;
  dealId: string;
  actorId: string;
  model: ModelTier;
  tokens: number;
};

export class TokenMeter {
  readonly entries: TokenSpend[] = [];

  record(spend: TokenSpend): void {
    this.entries.push(spend);
  }

  total(): number {
    return this.entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  byAgent(agent: string): number {
    return this.entries
      .filter((e) => e.agent === agent)
      .reduce((sum, e) => sum + e.tokens, 0);
  }
}
