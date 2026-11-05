/**
 * The Book deal view's status model (#191 slice 2): the deal's REAL rail
 * position rolled up into the canonical phases. The phase roll-up invents no
 * state — the current phase derives from the deal's cursor step exactly like
 * the rail does; this module only changes the altitude (5 phases, not 65
 * steps). The console task set (consoleTasks) IS fixture data, keyed by that
 * same phase so the two panels never disagree.
 */

import type { FixtureDeal } from '../rail/deals';
import { MOCK_DEAL_CONSOLE_BY_STEP } from '../mock/consoleTasks';
import {
  MOCK_DEAL_CONSOLE_BY_PHASE,
  type ConsolePhaseIndex,
  type MockConsoleTask,
} from '../mock/scale';
// MVP_DEAL_RAIL, not the default census: every cursorStepId producer
// (mapApiDeal, the rail) mints against the MVP rail — reading a different
// rail here would silently mis-place synthetic steps.
import { MVP_DEAL_RAIL, orderedSteps, phaseForStep, type RailStep } from '../rail/dealRail';

export type PhaseState = 'done' | 'current' | 'todo';

export type BookPhase = {
  index: number;
  name: string;
  gloss: string;
  state: PhaseState;
};

/** One-line glosses for the canonical 5 phases — deck-slide vocabulary
 *  adapted to OUR lifecycle (the census has five phases, not the slide's
 *  seven; the roll-up must be honest). */
const PHASE_GLOSS: Record<number, string> = {
  1: 'lead, conflicts clearance, engagement and kickoff',
  2: 'banker diligence, model, data room, CIM',
  3: 'buyer outreach, NDAs, management meetings, first bids',
  4: 'buyer Q&A, LOI markup, confirmatory diligence',
  5: 'definitive agreement, announcement, funds flow',
};

export function currentPhaseIndex(deal: FixtureDeal): number {
  return phaseForStep(deal.cursorStepId, MVP_DEAL_RAIL)?.index ?? 1;
}

export function bookPhases(deal: FixtureDeal): BookPhase[] {
  const current = currentPhaseIndex(deal);
  return MVP_DEAL_RAIL.map((phase) => ({
    index: phase.index,
    name: phase.name,
    gloss: PHASE_GLOSS[phase.index] ?? '',
    state:
      phase.index < current ? 'done' : phase.index === current ? 'current' : ('todo' as const),
  }));
}

/** "Day 42" — elapsed 24-hour windows since the creation instant, plus one,
 *  minimum 1. (Deliberately NOT calendar days: a preview label; calendar-day
 *  semantics are recorded on #168 if the Book view graduates.) */
export function dealDay(deal: FixtureDeal, now: Date = new Date()): number {
  const created = Date.parse(deal.createdAt ?? '');
  if (!Number.isFinite(created)) return 1;
  return Math.max(1, Math.floor((now.getTime() - created) / 86_400_000) + 1);
}

/** The phase after the current one, if any — the header's "next:". */
export function nextPhaseName(deal: FixtureDeal): string | null {
  const current = currentPhaseIndex(deal);
  return MVP_DEAL_RAIL.find((p) => p.index === current + 1)?.name ?? null;
}

/** The rail step the deal's cursor is on — the console's headline — or null
 *  for an off-rail cursor (a pending placeholder, a re-cut census). */
export function consoleStep(deal: FixtureDeal): RailStep | null {
  return orderedSteps(MVP_DEAL_RAIL).find((s) => s.id === deal.cursorStepId) ?? null;
}

/** The Deal Console's task set for the STEP the deal is actually on (Storm,
 *  Aug 24: each step carries its own task set) — fixture rows keyed by step
 *  id (no task system exists yet), picked via the same cursor the phase
 *  roll-up uses, so the two panels never disagree. An off-rail cursor falls
 *  back to the phase set (phase 1 when unknown, like currentPhaseIndex) —
 *  never a blank console. */
export function consoleTasks(deal: FixtureDeal): readonly MockConsoleTask[] {
  // Own-key lookup: a cursor id that happens to spell a prototype key must
  // fall back, not hand the console a function.
  if (Object.hasOwn(MOCK_DEAL_CONSOLE_BY_STEP, deal.cursorStepId)) {
    return MOCK_DEAL_CONSOLE_BY_STEP[deal.cursorStepId];
  }
  // currentPhaseIndex only ever yields a rail phase index (or 1); the rail's
  // indices are 1..5 by construction (tests/book-deal.test.tsx guards it).
  return MOCK_DEAL_CONSOLE_BY_PHASE[currentPhaseIndex(deal) as ConsolePhaseIndex];
}
