import { GENERATED_PHASES } from '@/lib/rail/railData.generated';

/**
 * Plain names for a seat's access phase (`deal_members.phase`).
 *
 * The server stores a number (0 and up) and gates an outside party's data room
 * documents by it (`documents.min_phase`); internal staff work the deal at
 * every phase (`src/lib/api/v1/documentAccess.ts`). People read phase NAMES,
 * not numbers, so access phase N is named after the Nth phase of the deal
 * rail, counting from 0 the way the lifecycle doc does ("Phase 0, Mandate and
 * origination"): 0 Origination, 1 Preparation, 2 Marketing, 3 Diligence,
 * 4 Signing. Anything past the last rail phase reads as the last one.
 *
 * Display only. The number is still what the API takes and returns.
 */

/** Short rail phase names: "Origination", "Preparation", … */
const ACCESS_PHASE_NAMES: readonly string[] = GENERATED_PHASES.map((p) =>
  p.name.split(/[,&]/)[0].trim(),
);

/** The highest access phase that has its own name. */
const LAST_NAMED_ACCESS_PHASE = ACCESS_PHASE_NAMES.length - 1;

/** "Preparation" for access phase 1. */
export function accessPhaseName(phase: number): string {
  const index = Math.min(Math.max(0, Math.trunc(phase)), LAST_NAMED_ACCESS_PHASE);
  return ACCESS_PHASE_NAMES[index];
}

/**
 * What a seat can see, in a few words: "Up to Preparation" for an outside
 * party, "Every phase" for your firm's own people (phase never gates them).
 */
export function accessSummary(member: { isExternal: boolean; phase: number }): string {
  return member.isExternal ? `Up to ${accessPhaseName(member.phase)}` : 'Every phase';
}

/**
 * The phases a seat can be moved to, from its current one upward. Access only
 * widens (the server refuses a lower phase), so earlier phases are not offered.
 * A seat already past the last named phase keeps its own number as the one
 * option.
 */
export function accessPhaseOptions(current = 0): { value: number; label: string }[] {
  const from = Math.max(0, Math.trunc(current));
  if (from > LAST_NAMED_ACCESS_PHASE) return [{ value: from, label: accessPhaseName(from) }];
  return ACCESS_PHASE_NAMES.slice(from).map((label, i) => ({ value: from + i, label }));
}
