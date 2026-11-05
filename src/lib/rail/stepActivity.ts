'use client';

import * as React from 'react';

import { readGeneration, subscribeGeneration } from '@/lib/api/inflightRead';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import type { StepActivityKind } from '@/lib/rail/boardContract';

/**
 * Who last did what on each step, read from the deal's audit trail.
 *
 * The steps PATCH writes one audit row per change through `deal_step_save`,
 * with `detail.stepId` = the step's catalog id (`deal_steps.step_id`, the
 * same key as `ProjectRailStep.stepId` and the step-records rows):
 *   assign_step   → "Assigned by {actor}"
 *   step_work     → "Draft saved by {actor}"
 *   complete_step → "Done by {actor}"
 * Rail structure rows (`update`, detail.rail = remove/restore/skip/insert)
 * key on the deal_steps row id instead and are not read here.
 *
 * GET /api/v1/deals/{id}/audit returns the newest 500 rows. A row inside that
 * window is the step's latest activity, so every line shown is exact. A step
 * whose last activity is older than the window shows no line at all: when the
 * read is capped the rail says less, never guesses. The fix is an additive
 * read-only `lastWorkAt` on step-records (handoff entry E22, "Last activity
 * per step without the 500-row audit cap").
 */

/** The audit route's read cap (`AUDIT_READ_LIMIT` in the route). */
export const AUDIT_READ_CAP = 500;

export type StepActivity = {
  kind: StepActivityKind;
  actorName: string;
  at: string;
  /** For an assignment: who the row assigned (`detail.assignee`). */
  assignee?: string;
};

export type StepActivityRead = {
  /** Latest activity per step, keyed by `ProjectRailStep.stepId`. */
  byStep: ReadonlyMap<string, StepActivity>;
  /** The trail filled the read cap: steps without a line may still have older activity. */
  capped: boolean;
};

type AuditActor = { full_name?: string | null; display_name?: string | null } | null;

export type AuditTrailEvent = {
  ts?: string;
  action?: string;
  detail?: Record<string, unknown> | null;
  actor?: AuditActor | AuditActor[];
};

const KIND_FOR_ACTION: Record<string, StepActivityKind> = {
  [AUDIT_ACTION.ASSIGN_STEP]: 'assigned',
  [AUDIT_ACTION.STEP_WORK]: 'draft_saved',
  [AUDIT_ACTION.COMPLETE_STEP]: 'completed',
};

/** One save can write work and completion in the same transaction (same ts):
 *  the completion is what happened. */
const KIND_RANK: Record<StepActivityKind, number> = { completed: 3, draft_saved: 2, assigned: 1 };

function actorNameOf(actor: AuditTrailEvent['actor']): string | null {
  const one = Array.isArray(actor) ? actor[0] : actor;
  return one?.display_name?.trim() || one?.full_name?.trim() || null;
}

export const EMPTY_ACTIVITY: StepActivityRead = { byStep: new Map(), capped: false };

/** Latest activity per step from audit rows (any order). Rows with no named
 *  person (service rows) are skipped: the line always names the actor. */
export function stepActivityFromAudit(
  events: readonly AuditTrailEvent[],
  cap: number = AUDIT_READ_CAP,
): StepActivityRead {
  const byStep = new Map<string, StepActivity>();
  for (const event of events) {
    const kind = event.action ? KIND_FOR_ACTION[event.action] : undefined;
    const stepId = typeof event.detail?.stepId === 'string' ? event.detail.stepId : null;
    const at = event.ts;
    const t = at ? Date.parse(at) : NaN;
    if (!kind || !stepId || !at || Number.isNaN(t)) continue;
    const actorName = actorNameOf(event.actor);
    if (!actorName) continue;
    const seen = byStep.get(stepId);
    const seenAt = seen ? Date.parse(seen.at) : -Infinity;
    if (!seen || t > seenAt || (t === seenAt && KIND_RANK[kind] > KIND_RANK[seen.kind])) {
      const assignee = kind === 'assigned' && typeof event.detail?.assignee === 'string' ? event.detail.assignee : undefined;
      byStep.set(stepId, assignee ? { kind, actorName, at, assignee } : { kind, actorName, at });
    }
  }
  return { byStep, capped: events.length >= cap };
}

/**
 * Drops an "Assigned by" line the step record no longer bears out. The PATCH
 * writes an `assign_step` row only when it assigns someone: removing an owner
 * writes none, and an assignee who leaves the deal leaves the old row behind.
 * So the latest assignment row is shown only while the record still names
 * that person; otherwise the step shows no activity line and does not count
 * as "Has activity". Steps with no record yet keep their line.
 */
export function withCurrentAssignment(
  byStep: ReadonlyMap<string, StepActivity>,
  records: readonly { stepId: string; assignedTo: string | null }[],
): ReadonlyMap<string, StepActivity> {
  if (records.length === 0) return byStep;
  const ownerOf = new Map(records.map((r) => [r.stepId, r.assignedTo]));
  let next: Map<string, StepActivity> | null = null;
  for (const [stepId, activity] of byStep) {
    if (activity.kind !== 'assigned' || !ownerOf.has(stepId)) continue;
    const owner = ownerOf.get(stepId) ?? null;
    const stale = owner === null || (activity.assignee !== undefined && activity.assignee !== owner);
    if (!stale) continue;
    next ??= new Map(byStep);
    next.delete(stepId);
  }
  return next ?? byStep;
}

/**
 * The deal's step activity, read once per rail load and again on `refresh`.
 * Off (empty, no fetch) on the fixture path. The last good read stays on
 * screen while a refresh is in flight, so a poll never blanks the lines.
 */
export function useStepActivity(
  dealId: string,
  enabled: boolean,
): StepActivityRead & {
  refresh: () => void;
  /** The audit read failed and no good read is on screen: never shown as "no activity". */
  failed: boolean;
} {
  // Shares the step-records generation: Try again and an identity change
  // re-read both (#162).
  const generation = React.useSyncExternalStore(
    subscribeGeneration,
    () => readGeneration(`step-records:${dealId}`),
    () => readGeneration(`step-records:${dealId}`),
  );
  const [read, setRead] = React.useState<{
    dealId: string;
    generation: number;
    value: StepActivityRead;
  } | null>(null);
  const [failure, setFailure] = React.useState<{ dealId: string; generation: number } | null>(null);
  const [tick, setTick] = React.useState(0);
  const refresh = React.useCallback(() => setTick((t) => t + 1), []);

  React.useEffect(() => {
    if (!enabled || !dealId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/audit`, {
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { events?: AuditTrailEvent[] };
        if (!Array.isArray(body.events)) throw new Error('no events');
        if (!cancelled) {
          setRead({ dealId, generation, value: stepActivityFromAudit(body.events) });
          setFailure(null);
        }
      } catch {
        // The cards keep the last good read (a failed poll never blanks
        // them); with none, the rail says the activity could not be loaded.
        if (!cancelled) setFailure({ dealId, generation });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId, enabled, tick, generation]);

  const good = read?.dealId === dealId && read.generation === generation;
  const value = good ? read.value : EMPTY_ACTIVITY;
  const failed =
    enabled && !good && failure?.dealId === dealId && failure.generation === generation;
  return { ...value, refresh, failed };
}
