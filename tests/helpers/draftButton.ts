/**
 * A step's draft buttons name what they make ("Draft the teaser", "Draft with
 * the Buyer NDA skill"; src/components/rail/stepActionCopy.ts). The step
 * detail's opener ends in "…" (it opens the draft panel); the runner's button
 * runs the skill.
 */
export const DRAFT_BUTTON = /^Draft (the |with the ).+[^…]$/;
export const OPEN_DRAFT_BUTTON = /^Draft (the |with the ).+…$/;
