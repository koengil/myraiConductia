// TargetUniverseAgent (mock) — the fake "Target Universe" skill behind the
// uniform contract, proving the platform ↔ skill communication end to end
// before a real Capital IQ / Pitchbook agent exists.
//
// Returns a canned candidate universe for the Atlassian example with the four
// fixed output fields agreed at the FP/RTS sync (sector, geography, ownership,
// growth). No external calls. It reads ONLY its pushed envelope and emits to
// the mandatory compliance channel. The real RTS skill swaps in here with zero
// spine changes.

import type { CapabilityAgent, AgentInput } from '../contract';
import type { AgentResult, TargetUniverseOutput } from '../types';

const CANNED_CANDIDATES: TargetUniverseOutput['candidates'] = [
  { name: 'Salesforce', sector: 'Software', geography: 'US', ownership: 'public', revenueGrowthPct: 11 },
  { name: 'ServiceNow', sector: 'Software', geography: 'US', ownership: 'public', revenueGrowthPct: 22 },
  { name: 'SAP', sector: 'Software', geography: 'EU', ownership: 'public', revenueGrowthPct: 9 },
  { name: 'Vista Equity Partners', sector: 'Private Equity', geography: 'US', ownership: 'pe-backed', revenueGrowthPct: 0 },
  { name: 'Canva', sector: 'Software', geography: 'APAC', ownership: 'private', revenueGrowthPct: 40 },
];

export class TargetUniverseAgent implements CapabilityAgent<TargetUniverseOutput> {
  readonly name = 'TargetUniverseAgent';

  async run(input: AgentInput): Promise<AgentResult<TargetUniverseOutput>> {
    const seller = input.envelope.brief?.sellerName ?? 'the seller';
    const saw = input.envelope.documents.map((d) => d.id);

    const result: TargetUniverseOutput = {
      candidates: CANNED_CANDIDATES,
      summary: `${CANNED_CANDIDATES.length} candidate acquirers screened for ${seller} across strategic and sponsor lanes.`,
    };

    input.report({
      agent: this.name,
      saw,
      did: 'Assembled the candidate target universe with fixed output fields.',
      why: 'A new mandate needs a screened acquirer universe before outreach planning.',
    });

    return {
      result,
      auditRecord: {
        saw,
        did: 'Assembled candidate universe.',
        why: 'Data-capture step for the new deal.',
        modelUsed: input.model,
        tokens: 900,
      },
      status: 'complete',
      completionAssertion: `Produced ${result.candidates.length} candidates with sector/geography/ownership/growth for ${seller}.`,
    };
  }
}
