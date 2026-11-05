'use client';

import * as React from 'react';

import { PROTECTED_STEP_IDS } from './protectedSteps';
import type { ProjectRailStep } from './projectRail';
import type { StepState } from '@/components/rail/stepState';

/*
 * Rail Previews: prototypes that run in this browser only and save nothing to
 * the deal. Each surface that uses them carries the shared PreviewChip or
 * PreviewBanner with a Reset. Engineer handoff entries
 * (docs/03-engineering/walkthrough-handoff-2026-10-22.md):
 *   - step order: E1 "Save a step reorder"
 *   - drawn links and step dates: E4 "Step dependencies, per-step dates"
 *   - proposals and the deal lead's review: E3 "Per-deal rail edit rights
 *     and Propose a change"
 */

// ---------------------------------------------------------------------------
// Step order (E1). Held in memory only: a reload puts the saved order back.

/** Step ids per phase, in the previewed order. */
export type PreviewOrder = Readonly<Record<number, readonly string[]>>;

/**
 * Whether a step can be moved in the Preview. Mirrors what a saved move would
 * have to refuse (E1): completed and required steps stay where they are, and
 * steps before the deal opened here are reference only.
 */
export function isMovableStep(step: ProjectRailStep, state: StepState): boolean {
  if (PROTECTED_STEP_IDS.has(step.stepId)) return false;
  return state === 'active' || state === 'todo' || state === 'skipped';
}

/**
 * A phase's steps in the previewed order. A step the order does not name (one
 * added after the Preview began) keeps its saved place: it follows the step
 * saved just before it, or leads when it was saved first.
 */
export function applyPreviewOrder(
  steps: readonly ProjectRailStep[],
  order: readonly string[] | undefined,
): readonly ProjectRailStep[] {
  if (!order || order.length === 0) return steps;
  const byId = new Map(steps.map((s) => [s.id, s]));
  const shown = order.map((id) => byId.get(id)).filter((s): s is ProjectRailStep => Boolean(s));
  const seen = new Set(shown.map((s) => s.id));
  steps.forEach((step, savedIndex) => {
    if (seen.has(step.id)) return;
    const before = savedIndex > 0 ? steps[savedIndex - 1] : null;
    const at = before ? shown.findIndex((s) => s.id === before.id) + 1 : 0;
    shown.splice(at, 0, step);
    seen.add(step.id);
  });
  return shown;
}

/**
 * Where a step may go in its phase (indices for `moveId`): never ahead of a
 * step that cannot move (done, required, before the deal opened here), since
 * a saved move would have to refuse that order (E1). Its own place is always
 * allowed.
 */
export function allowedMoveIndices(
  phaseSteps: readonly ProjectRailStep[],
  step: ProjectRailStep,
  isFixed: (step: ProjectRailStep) => boolean,
): ReadonlySet<number> {
  const others = phaseSteps.filter((s) => s.id !== step.id);
  let lastFixed = -1;
  others.forEach((s, i) => {
    if (isFixed(s)) lastFixed = i;
  });
  const allowed = new Set<number>();
  for (let k = lastFixed + 1; k <= others.length; k += 1) allowed.add(k);
  const from = phaseSteps.findIndex((s) => s.id === step.id);
  if (from >= 0) allowed.add(from);
  return allowed;
}

/** Moves `id` to `toIndex` within `ids`. Unknown ids or a no-op return the same list. */
export function moveId(ids: readonly string[], id: string, toIndex: number): readonly string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const clamped = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (clamped === from) return ids;
  const next = ids.filter((x) => x !== id);
  next.splice(clamped, 0, id);
  return next;
}

/** Whether a previewed order differs from the rail's own order. */
export function orderDiffers(steps: readonly ProjectRailStep[], order: readonly string[] | undefined): boolean {
  if (!order) return false;
  const shown = applyPreviewOrder(steps, order);
  return shown.some((s, i) => s.id !== steps[i]?.id);
}

/** Longest run of `seq` (saved indices) that keeps rising: positions in `seq`. */
function longestRisingRun(seq: readonly number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  seq.forEach((value, i) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  });
  const run: number[] = [];
  for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) run.unshift(k);
  return run;
}

/**
 * The steps a previewed phase order shows as moved, derived from the order
 * itself rather than from the moves that led there, so any order that
 * differs from the saved one marks at least one step (and so shows the
 * Preview chip, banner and Reset). The fewest steps that explain the order
 * are marked: those outside the longest run still in saved order. When the
 * step just moved can carry the mark on its own terms, it does. Steps the
 * saved order does not name (added since) are never marked. A phase back in
 * its saved order marks nothing.
 */
export function movedInOrder(
  shownIds: readonly string[],
  savedIds: readonly string[],
  justMovedId?: string,
): string[] {
  const savedAt = new Map(savedIds.map((id, i) => [id, i]));
  const known = shownIds.filter((id) => savedAt.has(id));
  const seq = known.map((id) => savedAt.get(id) as number);
  const full = longestRisingRun(seq);
  if (full.length === known.length) return [];
  let keep = new Set(full.map((i) => known[i]));
  if (justMovedId !== undefined && savedAt.has(justMovedId)) {
    const others = known.filter((id) => id !== justMovedId);
    const run = longestRisingRun(others.map((id) => savedAt.get(id) as number));
    if (run.length === full.length) keep = new Set(run.map((i) => others[i]));
  }
  return known.filter((id) => !keep.has(id));
}

type OrderState = { scope: string; order: Record<number, string[]>; moved: string[] };

/**
 * The Preview step order for one deal and identity, in memory (E1). Nothing
 * is written anywhere: a reload or a different deal shows the saved order.
 */
export function useReorderPreview(scope: string) {
  const [state, setState] = React.useState<OrderState | null>(null);
  const current = state?.scope === scope ? state : null;
  const order: PreviewOrder = current?.order ?? {};
  const moved = React.useMemo(() => new Set(current?.moved ?? []), [current]);

  const move = React.useCallback(
    (
      phaseIndex: number,
      phaseIds: readonly string[],
      id: string,
      toIndex: number,
      /** The phase's saved order: a step back in its saved place is no longer "moved". */
      savedIds?: readonly string[],
    ): boolean => {
      const next = moveId(phaseIds, id, toIndex);
      if (next === phaseIds) return false;
      setState((prev) => {
        const base = prev?.scope === scope ? prev : { scope, order: {}, moved: [] };
        const movedNow = base.moved.includes(id) ? base.moved : [...base.moved, id];
        if (!savedIds) {
          return { scope, order: { ...base.order, [phaseIndex]: [...next] }, moved: movedNow };
        }
        const inPhase = new Set([...phaseIds, ...savedIds]);
        const order = { ...base.order };
        const phaseMoved = movedInOrder(next, savedIds, id);
        if (phaseMoved.length === 0) delete order[phaseIndex];
        else order[phaseIndex] = [...next];
        // Marks come from the order, not the history of moves: a step
        // back in its saved place clears, and any differing order stays marked.
        const moved = [...base.moved.filter((x) => !inPhase.has(x)), ...phaseMoved];
        return moved.length === 0 && Object.keys(order).length === 0 ? null : { scope, order, moved };
      });
      return true;
    },
    [scope],
  );
  /**
   * A step left the rail (removed): it leaves the Preview order too, and the
   * marks and `active` are worked out again without it. A later
   * restore brings it back at its saved place, not its Preview one.
   */
  const drop = React.useCallback(
    (phaseIndex: number, id: string, savedIds: readonly string[]) => {
      setState((prev) => {
        if (!prev || prev.scope !== scope) return prev;
        const phaseOrder = prev.order[phaseIndex];
        const order = { ...prev.order };
        let phaseMoved: string[] = [];
        if (phaseOrder) {
          const next = phaseOrder.filter((x) => x !== id);
          phaseMoved = movedInOrder(next, savedIds.filter((x) => x !== id));
          if (phaseMoved.length === 0) delete order[phaseIndex];
          else order[phaseIndex] = next;
        }
        const inPhase = new Set([...(phaseOrder ?? []), ...savedIds]);
        const moved = [...prev.moved.filter((x) => x !== id && !inPhase.has(x)), ...phaseMoved];
        return moved.length === 0 && Object.keys(order).length === 0 ? null : { scope, order, moved };
      });
    },
    [scope],
  );
  const reset = React.useCallback(() => setState(null), []);
  // Any phase with a previewed order counts, so the banner and Reset never go missing.
  const active = moved.size > 0 || Object.keys(order).length > 0;
  return { order, moved, move, drop, reset, active };
}

// ---------------------------------------------------------------------------
// Drawn links, step dates and proposals (E3, E4). Kept in this browser
// (localStorage) per signed-in person and deal, so the Preview survives a
// reload; Reset clears it. Never read by the server or another viewer.

export type LinkKind = 'hard' | 'soft';

/** A link someone drew: `toId` waits on `fromId`. Never inferred from step briefs. */
export type DrawnLink = { id: string; fromId: string; toId: string; kind: LinkKind };

/** Calendar days as YYYY-MM-DD. */
export type StepDates = { start?: string; target?: string; dropDead?: string };

export type ProposalDecision = 'accepted' | 'discarded';

export type RailProposal = {
  id: string;
  /** The step the proposal is about, or null for the rail as a whole. */
  stepId: string | null;
  text: string;
  createdAt: string;
  decision: ProposalDecision | null;
};

export type RailPlanPreview = {
  links: DrawnLink[];
  dates: Record<string, StepDates>;
  proposals: RailProposal[];
};

export const EMPTY_PLAN: RailPlanPreview = { links: [], dates: {}, proposals: [] };

const PLAN_KEY_PREFIX = 'conductia.railPreview.v1.';

export function railPlanKey(userId: string | null, dealId: string): string {
  return `${PLAN_KEY_PREFIX}${userId ?? 'anon'}:${dealId}`;
}

function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Reads a stored plan, dropping anything malformed. */
export function parsePlan(raw: string | null): RailPlanPreview {
  if (!raw) return EMPTY_PLAN;
  try {
    const value = JSON.parse(raw) as Partial<RailPlanPreview>;
    const links = Array.isArray(value.links)
      ? value.links.filter(
          (l): l is DrawnLink =>
            typeof l?.id === 'string' &&
            typeof l.fromId === 'string' &&
            typeof l.toId === 'string' &&
            (l.kind === 'hard' || l.kind === 'soft'),
        )
      : [];
    const dates: Record<string, StepDates> = {};
    if (value.dates && typeof value.dates === 'object') {
      for (const [id, d] of Object.entries(value.dates)) {
        const entry: StepDates = {};
        if (isDay(d?.start)) entry.start = d.start;
        if (isDay(d?.target)) entry.target = d.target;
        if (isDay(d?.dropDead)) entry.dropDead = d.dropDead;
        if (entry.start || entry.target || entry.dropDead) dates[id] = entry;
      }
    }
    const proposals = Array.isArray(value.proposals)
      ? value.proposals.filter(
          (p): p is RailProposal =>
            typeof p?.id === 'string' &&
            typeof p.text === 'string' &&
            typeof p.createdAt === 'string' &&
            (p.stepId === null || typeof p.stepId === 'string') &&
            (p.decision === null || p.decision === 'accepted' || p.decision === 'discarded'),
        )
      : [];
    return { links, dates, proposals };
  } catch {
    return EMPTY_PLAN;
  }
}

function readPlan(key: string): RailPlanPreview {
  try {
    if (typeof window === 'undefined') return EMPTY_PLAN;
    return parsePlan(window.localStorage.getItem(key));
  } catch {
    return EMPTY_PLAN;
  }
}

function writePlan(key: string, plan: RailPlanPreview): void {
  try {
    if (typeof window === 'undefined') return;
    const empty = plan.links.length === 0 && Object.keys(plan.dates).length === 0 && plan.proposals.length === 0;
    if (empty) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(plan));
  } catch {
    // Private windows refuse storage: the Preview still works for this visit.
  }
}

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** Whether a link would join a step to itself or repeat one already drawn. */
export const LINK_LOOP_COPY = 'That would make these steps wait on each other in a loop.';

/** Whether `targetId` can be reached from `startId` along drawn links (from a step to the steps that wait on it). */
function reaches(links: readonly DrawnLink[], startId: string, targetId: string): boolean {
  const seen = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    for (const link of links) {
      if (link.fromId !== at || seen.has(link.toId)) continue;
      if (link.toId === targetId) return true;
      seen.add(link.toId);
      queue.push(link.toId);
    }
  }
  return false;
}

export function linkProblem(links: readonly DrawnLink[], fromId: string, toId: string): string | null {
  if (!fromId || !toId) return 'Choose both steps.';
  if (fromId === toId) return 'A step cannot wait on itself.';
  if (links.some((l) => l.fromId === fromId && l.toId === toId)) return 'That link is already drawn.';
  if (links.some((l) => l.fromId === toId && l.toId === fromId)) return 'Those steps already wait on each other the other way.';
  // "toId waits on fromId": refuse it when fromId already waits, at any
  // distance, on toId.
  if (reaches(links, toId, fromId)) return LINK_LOOP_COPY;
  return null;
}

/** A drop-dead date before the target date cannot be kept. */
export const DATES_ORDER_COPY = 'The drop-dead date cannot be before the target date.';
/** A start date after the target date cannot be kept. */
export const START_ORDER_COPY = 'The start date cannot be after the target date.';
export function datesProblem(target: string, dropDead: string, start = ''): string | null {
  if (start && target && start > target) return START_ORDER_COPY;
  return target && dropDead && dropDead < target ? DATES_ORDER_COPY : null;
}

/** The drawn links a step waits on whose earlier step is not done yet. */
export function waitingOn(
  stepId: string,
  links: readonly DrawnLink[],
  isDone: (id: string) => boolean,
): DrawnLink[] {
  return links.filter((l) => l.toId === stepId && !isDone(l.fromId));
}

/** The soonest Preview date on the rail, for the header beside the real target close. */
export function soonestStepDate(
  dates: Readonly<Record<string, StepDates>>,
  stepIds: ReadonlySet<string>,
): { stepId: string; day: string; kind: 'target' | 'dropDead' } | null {
  let best: { stepId: string; day: string; kind: 'target' | 'dropDead' } | null = null;
  for (const [stepId, d] of Object.entries(dates)) {
    if (!stepIds.has(stepId)) continue;
    for (const kind of ['dropDead', 'target'] as const) {
      const day = d[kind];
      if (day && (!best || day < best.day)) best = { stepId, day, kind };
    }
  }
  return best;
}

/** The Preview plan for one person and deal, kept in this browser (E3, E4). */
export function useRailPlanPreview(key: string) {
  const [state, setState] = React.useState<{ key: string; plan: RailPlanPreview }>(() => ({
    key,
    plan: readPlan(key),
  }));
  // A different person or deal reads its own plan.
  if (state.key !== key) setState({ key, plan: readPlan(key) });
  const plan = state.key === key ? state.plan : EMPTY_PLAN;

  const update = React.useCallback(
    (change: (prev: RailPlanPreview) => RailPlanPreview) => {
      setState((prev) => {
        const base = prev.key === key ? prev.plan : readPlan(key);
        const next = change(base);
        writePlan(key, next);
        return { key, plan: next };
      });
    },
    [key],
  );

  const addLink = React.useCallback(
    (fromId: string, toId: string, kind: LinkKind) =>
      update((p) =>
        linkProblem(p.links, fromId, toId)
          ? p
          : { ...p, links: [...p.links, { id: newId('link'), fromId, toId, kind }] },
      ),
    [update],
  );
  const removeLink = React.useCallback(
    (id: string) => update((p) => ({ ...p, links: p.links.filter((l) => l.id !== id) })),
    [update],
  );
  const setDates = React.useCallback(
    (stepId: string, dates: StepDates) =>
      update((p) => {
        const next = { ...p.dates };
        const entry: StepDates = {};
        if (isDay(dates.target)) entry.target = dates.target;
        if (isDay(dates.dropDead)) entry.dropDead = dates.dropDead;
        if (isDay(dates.start)) entry.start = dates.start;
        if (entry.start || entry.target || entry.dropDead) next[stepId] = entry;
        else delete next[stepId];
        return { ...p, dates: next };
      }),
    [update],
  );
  const resetPlan = React.useCallback(
    () => update((p) => ({ ...p, links: [], dates: {} })),
    [update],
  );

  const propose = React.useCallback(
    (stepId: string | null, text: string) =>
      update((p) => ({
        ...p,
        proposals: [
          ...p.proposals,
          { id: newId('proposal'), stepId, text: text.trim(), createdAt: new Date().toISOString(), decision: null },
        ],
      })),
    [update],
  );
  const decide = React.useCallback(
    (id: string, decision: ProposalDecision | null) =>
      update((p) => ({
        ...p,
        proposals: p.proposals.map((x) => (x.id === id ? { ...x, decision } : x)),
      })),
    [update],
  );
  const resetProposals = React.useCallback(
    () => update((p) => ({ ...p, proposals: [] })),
    [update],
  );

  return { plan, addLink, removeLink, setDates, resetPlan, propose, decide, resetProposals };
}
