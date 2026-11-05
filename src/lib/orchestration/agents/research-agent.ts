// ResearchAgent (mock) — a leashed capability node behind the uniform contract.
//
// Returns a fixed comp set and a short market read for the Atlassian example.
// No external calls. It reads ONLY its pushed envelope and emits to the
// mandatory compliance channel. A real research agent swaps in here with zero
// spine changes.

import type { CapabilityAgent, AgentInput } from '../contract';
import type { AgentResult, ResearchOutput } from '../types';

const CANNED_COMPS: ResearchOutput['comps'] = [
  { name: 'Salesforce', evRevenue: 7.1 },
  { name: 'ServiceNow', evRevenue: 14.8 },
  { name: 'Workday', evRevenue: 6.4 },
];

export class ResearchAgent implements CapabilityAgent<ResearchOutput> {
  readonly name = 'ResearchAgent';

  async run(input: AgentInput): Promise<AgentResult<ResearchOutput>> {
    const seller = input.envelope.brief?.sellerName ?? 'the seller';
    const saw = input.envelope.documents.map((d) => d.id);

    const result: ResearchOutput = {
      comps: CANNED_COMPS,
      marketRead: `${seller} sits in a durable, category-leading position; public peers trade at a premium to the broader software tape.`,
    };

    input.report({
      agent: this.name,
      saw,
      did: 'Assembled a comparable-company set and a market read.',
      why: 'The teaser requires a defensible comp spread and a one-line market posture.',
    });

    return {
      result,
      auditRecord: {
        saw,
        did: 'Assembled comps + market read.',
        why: 'Inputs for the teaser draft.',
        modelUsed: input.model,
        tokens: 1200,
      },
      status: 'complete',
      completionAssertion: `Produced ${result.comps.length} comps and a market read for ${seller}.`,
    };
  }
}
