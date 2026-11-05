// Which stage assessment a reader is shown (#173 G-07, design R5). Pure: it takes the rows RLS already let the
// reader see and picks one, so it can show nothing the reader could not read. Display only (the candidate list, the
// detail and so the Promote default, the rail marker); every write others can read uses the shared row in SQL.

import { MVP_DEAL_RAIL, orderedSteps, type RailPhase } from '@/lib/rail/dealRail';

/** The columns the rule reads. A row without team_mailbox_id (the schema before 20261023130100) is shared. */
export type AssessmentKey = {
  step_id: string | null;
  team_mailbox_id?: string | null;
  as_of: string;
  id?: string;
};

/** Newer first: as_of, then id, the order the writer reads "latest" in. */
const newer = (a: AssessmentKey, b: AssessmentKey) => a.as_of > b.as_of || (a.as_of === b.as_of && (a.id ?? '') > (b.id ?? ''));

/**
 * The latest row of each team inbox the reader may see, kept only while it names a step: the one furthest along
 * the rail, then the latest. With none, the latest shared row. Null when the reader sees no row at all.
 */
export function preferredAssessment<T extends AssessmentKey>(rows: readonly T[], rail: readonly RailPhase[] = MVP_DEAL_RAIL): T | null {
  const steps = orderedSteps(rail);
  const rank = (stepId: string) => steps.findIndex((s) => s.id === stepId);
  let shared: T | null = null;
  const latestByTeam = new Map<string, T>();
  for (const row of rows) {
    const team = row.team_mailbox_id ?? null;
    if (team === null) {
      if (!shared || newer(row, shared)) shared = row;
      continue;
    }
    const seen = latestByTeam.get(team);
    if (!seen || newer(row, seen)) latestByTeam.set(team, row);
  }
  let best: T | null = null;
  for (const row of latestByTeam.values()) {
    if (row.step_id === null) continue; // a tombstone: this inbox adds nothing now
    if (!best) {
      best = row;
      continue;
    }
    const d = rank(row.step_id) - rank(best.step_id!);
    if (d > 0 || (d === 0 && newer(row, best))) best = row;
  }
  return best ?? shared;
}
