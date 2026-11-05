// Skill-library governance model — pure derivations over the canonical rail.
//
// The skills destination reframes every rail step as a governed step-skill
// (develop-design vision spec §4.5, the reference UI steal #8). Nothing here is stored:
// the approval state is DERIVED from the two honest axes the rail already
// carries — the typed seam-skill link (`skillId`) and the reality axis
// (live / schema / planned) — so the library can never drift from the rail.
//
//   active   → the skill runs in the product today. The five seam skills
//              (src/lib/api/fixtures.ts) run as live panels on the acquirer
//              deep-dive canvas; the Teaser step (seq 36) runs the live
//              orchestration spine on the rail.
//   approved → the contract is approved and canned agent drafts exist
//              (reality: schema); live wiring is scheduled.
//   proposed → captured from the ledger, awaiting approval and build
//              (reality: planned).
//
// There is deliberately NO self-serve enablement and no per-seat paywall on
// this surface: skills are distributed by the organization and approved
// through compliance (the approval-state chip replaces the reference enable toggle).

import type {
  ExecutionClass,
  RailBuildOwner,
  RailStep,
} from '@/lib/rail/dealRail';
import type { BadgeTone } from '@/components/atoms';

export type SkillApprovalState = 'active' | 'approved' | 'proposed';

export const APPROVAL_STATE_LABEL: Record<SkillApprovalState, string> = {
  active: 'Active',
  approved: 'Approved',
  proposed: 'Proposed',
};

/** Chip tone per state. Single-accent discipline (the reference UI steal #1, navy):
 *  --accent carries exactly the live/selected duties — ★ priority marks,
 *  Active chips, primary actions, selection — so Active reads accent and the
 *  pending states stay on hold / neutral duty. Token-driven; the conductor
 *  re-skins token values at integration. */
export const APPROVAL_STATE_TONE: Record<SkillApprovalState, BadgeTone> = {
  active: 'accent',
  approved: 'hold',
  proposed: 'neutral',
};

/** One-line explanation rendered with the state chip in the detail view. */
export const APPROVAL_STATE_EXPLAINED: Record<SkillApprovalState, string> = {
  active: 'This skill runs in the product today.',
  approved:
    'The skill contract is approved and drafted outputs exist. Live wiring is scheduled.',
  proposed:
    'Captured from the ledger. Awaiting compliance approval and build.',
};

/**
 * Derive the library approval state for a step. skillId marks the five steps
 * whose skill runs as a live seam panel today; the reality axis carries the
 * rest (the live spine-wired Teaser step is equally Active).
 */
export function approvalStateForStep(step: RailStep): SkillApprovalState {
  if (step.skillId || step.reality === 'live') return 'active';
  if (step.reality === 'schema') return 'approved';
  return 'proposed';
}

/** Compact owner chip labels for the card grammar (full labels come from
 *  BUILD_OWNER_LABEL and are used in the detail view). */
export const OWNER_CHIP_LABEL: Record<RailBuildOwner, string> = {
  rts: 'RTS',
  'futureproofing-os': 'FP·OS',
};

/** Plain-language explanation of each execution class (detail view). */
export const EXECUTION_CLASS_EXPLAINED: Record<ExecutionClass, string> = {
  A: 'The agent executes this step end to end. Output lands in the deal record with full provenance.',
  'A+H':
    'The agent drafts. A named human reviews and approves before the output is used or released.',
  'H+A':
    'A human leads the work. The agent assists, checks, and records alongside.',
  H: 'A human performs this step. The platform records the confirmation and the artifacts.',
  unknown: 'Execution class not yet classified in the ledger.',
};
