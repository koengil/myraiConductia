// TargetUniverseReviewAgent — the paired reviewer over the Target Universe
// skill (skill-authoring-rules.md: a reviewer agent gates skill output before
// a human sees it). Deterministic field validation, no LLM: it checks the
// fixed output contract, never re-does the work. Receives the skill's output
// via envelope.priorFindings — context pushed, never pulled.

import type { CapabilityAgent, AgentInput } from '../contract';
import type { AgentResult, SkillReviewVerdict, TargetUniverseOutput } from '../types';

const OWNERSHIP_VALUES = ['public', 'private', 'pe-backed'] as const;

function validate(output: TargetUniverseOutput): string[] {
  const issues: string[] = [];
  if (output.candidates.length === 0) issues.push('candidate list is empty');
  if (!output.summary?.trim()) issues.push('summary is missing');
  output.candidates.forEach((c, i) => {
    if (!c.name?.trim()) issues.push(`candidate ${i}: name is missing`);
    if (!c.sector?.trim()) issues.push(`candidate ${i}: sector is missing`);
    if (!c.geography?.trim()) issues.push(`candidate ${i}: geography is missing`);
    if (!OWNERSHIP_VALUES.includes(c.ownership)) issues.push(`candidate ${i}: ownership is invalid`);
    if (!Number.isFinite(c.revenueGrowthPct)) issues.push(`candidate ${i}: revenueGrowthPct is not a number`);
  });
  return issues;
}

export class TargetUniverseReviewAgent implements CapabilityAgent<SkillReviewVerdict> {
  readonly name = 'TargetUniverseReviewAgent';

  async run(input: AgentInput): Promise<AgentResult<SkillReviewVerdict>> {
    const saw = input.envelope.documents.map((d) => d.id);
    const output = input.envelope.priorFindings?.output as TargetUniverseOutput | undefined;

    if (!output) {
      return {
        result: { approved: false, issues: ['no skill output was pushed to review'] },
        auditRecord: {
          saw,
          did: 'Nothing: no prior findings in the envelope.',
          why: 'The reviewer validates a skill output; none was provided.',
          modelUsed: input.model,
          tokens: 0,
        },
        status: 'needs_input',
        completionAssertion: 'Review could not run without a pushed skill output.',
      };
    }

    const issues = validate(output);
    const approved = issues.length === 0;

    input.report({
      agent: this.name,
      saw,
      did: `Validated the target universe output (${approved ? 'approved' : `${issues.length} issue(s)`}).`,
      why: 'Skill output must pass the fixed-field contract before a banker sees it.',
    });

    return {
      result: { approved, issues },
      auditRecord: {
        saw,
        did: approved ? 'Approved the skill output.' : `Rejected the skill output: ${issues.join('; ')}.`,
        why: 'Paired-reviewer gate over the fixed output contract.',
        modelUsed: input.model,
        tokens: 150,
      },
      status: 'complete',
      completionAssertion: approved
        ? `All ${output.candidates.length} candidates carry the four fixed fields.`
        : `Found ${issues.length} contract violation(s).`,
    };
  }
}
