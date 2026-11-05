// DraftAgent (mock) — composes a teaser draft from the pushed research findings
// and the deal brief stub. Deterministic so the spine's tests stay hermetic and
// replayable; a real model call would slot in behind this same contract and
// envelope (the kickoff explicitly allows it). The brief headline is carried
// verbatim so the compliance supervisor screens real draft content.

import type { CapabilityAgent, AgentInput } from '../contract';
import type { AgentResult, DraftOutput, ResearchOutput } from '../types';

/**
 * The brief's stand-in when no seller name may be shown (a blind teaser).
 * The title then reads "Confidential Teaser" alone, never "Project the seller".
 */
export const UNNAMED_SELLER = 'the seller';

/** The teaser title: "Project {name}: Confidential Teaser" only for a real name. */
export function teaserTitle(sellerName: string | undefined): string {
  const seller = sellerName?.trim();
  if (!seller || seller.toLowerCase() === UNNAMED_SELLER) return 'Confidential Teaser';
  return `Project ${seller}: Confidential Teaser`;
}

/** Capitalises the first letter of each sentence in a paragraph. */
export function capitaliseSentences(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, letter: string) => lead + letter.toUpperCase());
}

function readResearch(input: AgentInput): ResearchOutput | undefined {
  return input.envelope.priorFindings?.research as ResearchOutput | undefined;
}

export class DraftAgent implements CapabilityAgent<DraftOutput> {
  readonly name = 'DraftAgent';

  async run(input: AgentInput): Promise<AgentResult<DraftOutput>> {
    const brief = input.envelope.brief;
    const research = readResearch(input);
    const saw = input.envelope.documents.map((d) => d.id);

    const seller = brief?.sellerName?.trim() || UNNAMED_SELLER;
    const headline = brief?.headline ?? '';
    const compLine = research
      ? `Selected comparables: ${research.comps.map((c) => c.name).join(', ')}.`
      : 'Selected comparables: available on request.';
    const marketLine = research?.marketRead ?? '';

    const teaser = [teaserTitle(brief?.sellerName), headline, marketLine, compLine]
      .filter(Boolean)
      .map(capitaliseSentences)
      .join('\n\n');

    input.report({
      agent: this.name,
      saw,
      did: 'Drafted the one-page teaser.',
      why: 'The job goal is an external-facing teaser for the seller.',
    });

    return {
      result: { teaser },
      auditRecord: {
        saw,
        did: 'Drafted the teaser.',
        why: 'External-facing artifact for the mandate.',
        modelUsed: input.model,
        tokens: 3400,
      },
      status: 'complete',
      completionAssertion: `Drafted a ${teaser.length}-character teaser for ${seller}.`,
    };
  }
}
