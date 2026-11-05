import { MD_BRIEFING_STEP_ID, TEASER_STEP_ID } from '@/lib/rail/dealRail';
import { GATE0_NOTIFY_STEP_ID } from '@/lib/rail/gate0';

/**
 * What the draft button on a step says, and the one plain line that tells the
 * banker what Conductia does and what they do. The button names the output
 * where the step has a known one ("Draft the teaser"); every other step says
 * which skill drafts it, so no button reads "Draft this step".
 */
const KNOWN_OUTPUT: Record<string, { label: string; line: string }> = {
  [TEASER_STEP_ID]: {
    label: 'Draft the teaser',
    line: 'Conductia drafts the teaser. You review and sign off.',
  },
  [MD_BRIEFING_STEP_ID]: {
    label: 'Draft the MD brief',
    line: 'Conductia drafts the MD brief. You review it before you mark the step complete.',
  },
};

/** Steps whose output is known: their draft button never depends on a skill read. */
export function hasKnownOutput(stepId: string): boolean {
  return stepId in KNOWN_OUTPUT;
}

/** The plain line where a step has no skill to draft with. */
export const NO_SKILL_YET = 'No skill attached yet.';
/** Opens the draft panel for a step with no skill but earlier runs (its drafts stay revisable). */
export const OPEN_EARLIER_DRAFTS = 'Open earlier drafts…';
export const SKILL_NOT_READ = "This step's skill could not be read right now.";

/** The button that runs the step's skill: "Draft the teaser", "Draft with the Buyer NDA skill". */
export function draftActionLabel(stepId: string, title: string): string {
  return KNOWN_OUTPUT[stepId]?.label ?? `Draft with the ${title} skill`;
}

/** The button on the step that opens its draft panel: the same words, plus "…" (more to choose first). */
export function openDraftLabel(stepId: string, title: string): string {
  return `${draftActionLabel(stepId, title)}…`;
}

/** The plain line on a manual step: the banker works the checklist, Conductia keeps the record. */
export const MANUAL_PLAIN_LINE = 'You complete this checklist. Conductia records it on the deal.';

/**
 * The plain line on Relationship Pathing: the banker picks each stakeholder's
 * introducer (a listed relationship, or Cold) and approves. The paths are
 * saved on the target company, shared with Leads; the approval completes the
 * step on the deal (RelationshipPathingPanel).
 */
export const RELATIONSHIP_PATHING_PLAIN_LINE =
  'You choose an introducer, or Cold, for each stakeholder and approve the paths. Conductia saves them to the target and records the step on the deal.';

/**
 * A reference-only step's one plain line: it is read, never worked, so no
 * manual or drafting line applies.
 */
export const PRIOR_PLAIN_LINE = 'Happened before this deal opened in Conductia. Reference only.';
export const SKIPPED_PLAIN_LINE = 'Skipped with an approved, logged reason. The record stays.';

/**
 * The Gate 0 record steps are done in the intake wizard when the mandate
 * opens (Gate0Wizard: code name, then the senior partner's conflicts
 * approval, then the screened notice to compliance on create).
 */
const GATE0_PLAIN_LINE: Record<string, string> = {
  'p1-s7': 'Created in the Gate 0 intake when the mandate opened.',
  'p1-s6': "The senior partner's conflicts approval, recorded in the Gate 0 intake.",
  [GATE0_NOTIFY_STEP_ID]:
    'Conductia screened the Gate 0 notice and sent it to compliance when the mandate opened.',
};

export function gate0PlainLine(stepId: string): string | null {
  return GATE0_PLAIN_LINE[stepId] ?? null;
}

/** One sentence: what Conductia does on this step, and what the banker does. */
export function draftPlainLine(stepId: string, title: string): string {
  return (
    KNOWN_OUTPUT[stepId]?.line ??
    `Conductia drafts with the ${title} skill. You review the draft before you mark the step complete.`
  );
}

/**
 * The button that only moves the deal's current step on (PATCH /progress,
 * which writes the cursor and nothing on the step row). It never says
 * "Mark complete": that label belongs to buttons that complete the step
 * through the step PATCH (manual steps). Recording completion here is handoff
 * E28, "Mark complete" on a skill-backed step only moves the current step;
 * until then the label says what the button does.
 */
export const ADVANCE_ONLY_LABEL = 'Move to the next step';
export const ADVANCE_ONLY_NOTE = "This moves the deal's current step. It does not record this step as done.";

/**
 * Why Complete and Skip are not available: the seat cannot act (an
 * Observer, or the server answered 403), or the step is not the current step.
 */
export const SEAT_CANNOT_ACT = "Your seat can't complete or skip this step.";
export const COMPLETE_CURRENT_FIRST = 'Complete the current step first.';
/** Why Save progress is not available: the seat cannot edit this step's work. */
export const SEAT_CANNOT_SAVE = "Your seat can't save progress on this step.";
/**
 * Why Save progress is not available: the step is a colleague's. On the bank
 * side the step's work is saved by its assignee, the deal MD or a firm
 * administrator (canEditWork in resolveDealStepCapabilities, which counts a
 * firm administrator as the deal's MD).
 */
export function assignedElsewhereCopy(name: string): string {
  return `Assigned to ${name}. Only they, the MD or a firm administrator can save progress.`;
}
