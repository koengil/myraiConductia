// The compliance agent as a supervisor OVER the graph, not a step in it
// (kickoff #6). Two modes:
//
//   1. A hard pre-send gate on anything leaving the firm — clear / hold / block.
//      This wraps the existing, tested screenMessage() rule pack
//      (src/lib/compliance/screen.ts, ported from the v2 prototype, ADR-0003);
//      it is NOT re-implemented here. compliant -> clear (advance),
//      hold -> route to human, blocked -> BLOCKED.
//
//   2. A continuous monitor that records what each agent saw, did and why, with
//      authority to halt a rogue agent. The floor is the sealed envelope: if an
//      agent reports having seen an artifact it was never given, it pulled data
//      it should not have, and the monitor halts it. FINRA cares about rogue
//      agents, so the audit trail covers agents, not just users.

import { screenMessage } from '../../compliance/screen';
import type { ComplianceCheckResult } from '../../api/types';
import type { ComplianceMonitorEntry, GateDecision } from '../types';

export type GateOutcome = {
  decision: GateDecision;
  result: ComplianceCheckResult;
};

export type MonitorVerdict = {
  halt: boolean;
  reason?: string;
};

const VERDICT_TO_DECISION: Record<ComplianceCheckResult['verdict'], GateDecision> = {
  compliant: 'clear',
  hold: 'hold',
  blocked: 'block',
};

export class ComplianceSupervisor {
  /** Pre-send gate. Delegates the rules verbatim to screenMessage(). */
  gate(text: string): GateOutcome {
    const result = screenMessage(text);
    return { decision: VERDICT_TO_DECISION[result.verdict], result };
  }

  /**
   * Monitor a single agent report against the envelope it was handed. An agent
   * may only ever have seen artifacts that were pushed to it; anything else is
   * an out-of-scope pull and is halted.
   */
  inspect(entry: ComplianceMonitorEntry, allowedArtifactIds: string[]): MonitorVerdict {
    const allowed = new Set(allowedArtifactIds);
    const leaked = entry.saw.filter((id) => !allowed.has(id));
    if (leaked.length > 0) {
      return {
        halt: true,
        reason: `${entry.agent} saw out-of-envelope artifact(s): ${leaked.join(', ')}`,
      };
    }
    return { halt: false };
  }
}
