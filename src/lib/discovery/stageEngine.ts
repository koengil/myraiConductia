// The stage engine: milestone events in, a suggested step, a lifecycle and a
// templated reason out. Pure and versioned, like scoring/composite.ts: the same
// events and rail always give the same assessment, and no model is involved.

import { orderedSteps, type RailPhase } from '@/lib/rail/dealRail';

import {
  MILESTONE_STATION,
  REGRESSION_TYPES,
  type MilestoneEvent,
} from './milestones';
import { reasonText } from './reason';

// v2 (#173 G-07): lifecycle is read from model events only; a rule event places a station, never a lifecycle.
export const ENGINE_VERSION = 'stage-engine/v2';

export type AssessmentFlag = 'conflict' | 'station_removed' | 'overridden';
export type StationOverride = { stepId: string };
export type Lifecycle = 'live' | 'closed' | 'terminated' | 'mandate_hold';

export type StageAssessment = {
  stepId: string | null;
  station: number | null;
  lifecycle: Lifecycle | null;
  reason: string;
  evidenceEventIds: string[];
  confidence: number;
  flags: AssessmentFlag[];
  engineVersion: string;
};

/**
 * Closed wins. Otherwise the latest pause or termination that no mapped event
 * follows decides. With neither, a deal that has any mapped event is live.
 */
function lifecycleOf(byDate: MilestoneEvent[]): Lifecycle | null {
  if (byDate.some((e) => e.type === 'closed')) return 'closed';
  const stops = byDate.filter((e) => e.type === 'process_paused' || e.type === 'process_terminated');
  const lastStop = stops.at(-1);
  if (lastStop) {
    const followed = byDate.some((e) => MILESTONE_STATION[e.type] && e.occurredAt > lastStop.occurredAt);
    if (!followed) return lastStop.type === 'process_terminated' ? 'terminated' : 'mandate_hold';
  }
  return byDate.some((e) => MILESTONE_STATION[e.type]) ? 'live' : null;
}

export function assessStage(
  events: MilestoneEvent[],
  rail: readonly RailPhase[],
  override?: StationOverride,
): StageAssessment {
  const steps = orderedSteps(rail);
  const indexOf = (stepId: string) => steps.findIndex((s) => s.id === stepId);
  const rank = (e: MilestoneEvent) => indexOf(MILESTONE_STATION[e.type]!);
  const byDate = [...events].sort(
    (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
  );
  const mapped = byDate.filter((e) => MILESTONE_STATION[e.type]);
  const flags: AssessmentFlag[] = [];

  // 1. The leading event: highest step, then latest date (inactivity is never termination).
  let lead = mapped.reduce<MilestoneEvent | null>((best, e) => {
    if (!best) return e;
    const d = rank(e) - rank(best);
    return d > 0 || (d === 0 && e.occurredAt >= best.occurredAt) ? e : best;
  }, null);

  // 2. A regression after the lead moves the deal back, flagged as a conflict.
  const leadDate = lead?.occurredAt;
  const regression = lead
    ? mapped.filter((e) => REGRESSION_TYPES.has(e.type) && e.occurredAt > leadDate!).at(-1)
    : undefined;
  if (regression) {
    lead = regression;
    flags.push('conflict');
  }

  // 3. Lifecycle, from model events only: closed wins; otherwise the latest pause or termination not followed by
  //    a mapped event. A rule match can suggest a station but never close, pause or end a deal.
  const lifecycle = lifecycleOf(byDate.filter((e) => e.basis === 'model'));

  if (!lead) {
    return {
      stepId: null,
      station: null,
      lifecycle,
      reason: 'No milestones extracted yet',
      evidenceEventIds: [],
      confidence: 0,
      flags,
      engineVersion: ENGINE_VERSION,
    };
  }

  const stepId = MILESTONE_STATION[lead.type]!;
  const idx = indexOf(stepId);
  if (idx < 0) flags.push('station_removed');
  const cited = mapped.filter((e) => e.type === lead!.type && e.occurredAt === lead!.occurredAt);
  const emails = new Set(cited.map((e) => e.sourceItemId)).size;
  if (override && override.stepId !== stepId) flags.push('overridden');
  const title = idx >= 0 ? steps[idx].title : stepId;
  return {
    stepId,
    station: idx >= 0 ? idx + 1 : null,
    lifecycle,
    reason: reasonText(title, lead.type, lead.occurredAt, emails),
    evidenceEventIds: cited.map((e) => e.id),
    confidence:
      Math.min(1, Math.max(...cited.map((e) => e.confidence))) * (flags.includes('conflict') ? 0.7 : 1),
    flags,
    engineVersion: ENGINE_VERSION,
  };
}
