/**
 * The Conductor Center's read model. Every row derives from data the platform
 * already holds, read once: the deal list (GET /api/v1/deals) and the
 * caller's notifications. No task system exists yet, so nothing here invents
 * one, and nothing here reads a deal's rail one by one (#162 fan-out).
 *
 *   Needs your judgment  the caller's UNREAD notifications that ask for a
 *                        decision, most consequential first, each with one
 *                        primary action.
 *   Due today            deals whose target close date is today. Nothing
 *                        else has a date behind it yet (per-step deadlines
 *                        need stored step dates, handoff E4).
 *   Running              deals whose current step has a draft run in flight
 *                        (`benchRunStatus === 'running'`). Nothing else; the
 *                        section renders only when one exists. Nothing writes
 *                        bench_run_status yet (handoff E19).
 *   Your deals           one row per deal: phase, % of the phase done, the
 *                        current step, who is on it, target close and how
 *                        many items need you.
 *
 * "% of phase" is done over total for the current phase from the deal's own
 * steps (`phaseProgress`); "on it" is the current step's assignee. Both are
 * null when the deal list does not carry them (fixture deals, older schema).
 */

import { NOTIFICATION_EVENT } from '../constants/notifications';
import { BENCH_RUN_STATUS } from '../constants/dealSteps';
import type { LifecycleCategory } from '../constants/deals';
import type { ListedDeal } from './useDeals';
import type { AppNotification } from '../notifications/useNotifications';
import { storedHrefWithDealCode } from '../notifications/navBadges';
import { notificationEventLabel } from '../notifications/eventLabels';
import { relativeTime } from '../notifications/relativeTime';
import { MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '../rail/dealRail';
import { catalogFor } from '../rail/projectRail';

/** Shown in the On it column when no one is assigned to the current step. */
export const UNASSIGNED_LABEL = 'Unassigned';

/** What a Running row says Conductia is doing. */
export const RUNNING_LABEL = 'Conductia is drafting';

/** An item with nowhere to go still gets one action: clear it. */
export const MARK_READ_LABEL = 'Mark as read';

export type PhaseSegment = 'done' | 'current' | 'todo';

export type DealRow = {
  dealId: string;
  code: string;
  codename: string;
  /** 1..5, or null when the deal has no phase the rail knows. */
  phaseIndex: number | null;
  /** The phase NAME (glossary: always name it). */
  phase: string;
  /** Done over total in the current phase, 0..100; null when unknown. */
  phasePercent: number | null;
  /** One entry per phase on the default rail. */
  meter: PhaseSegment[];
  /** Census seq: what the rail's ?step= deep link matches on. */
  stepSeq: number | null;
  stepTitle: string;
  hasCurrentStep: boolean;
  /** The person the current step is assigned to, when the deal list says. */
  assigneeName: string | null;
  /** A draft run is in flight on the current step. */
  running: boolean;
  href: string;
  /** ISO calendar date (YYYY-MM-DD) or null. */
  targetCloseDate: string | null;
  /** Unread items on this deal that need the caller. */
  needsYou: number;
  category: LifecycleCategory;
  /** Position on the default rail, for "furthest along" ordering only. */
  progressKey: number;
};

export type NeedsYouRow = {
  id: string;
  title: string;
  codename: string | null;
  /** The deal code from the payload, used to count items per deal. */
  dealCode: string | null;
  meta: string;
  href: string | null;
  eventType: string;
  requestId: string | null;
  destinationLabel: string | null;
  actor: string | null;
  /** The one primary action's visible label. */
  actionLabel: string;
};

const MVP_STEPS = orderedSteps(MVP_DEAL_RAIL);
const MVP_POSITION = new Map(MVP_STEPS.map((s, i) => [s.id, i]));

function railHref(segment: string, stepSeq: number | null): string {
  // `!= null`, not truthiness: the Gate 0 Notify step is seq 0 and IS a step.
  return stepSeq != null ? `/projects/${segment}/rail?step=${stepSeq}` : `/projects/${segment}/rail`;
}

/** The events that put something on the MD's desk, most consequential first.
 *  The rest of the enum (signed, promoted, completed, approved, member added,
 *  mandate opened) is FYI: it stays in the bell. */
const NEEDS_YOU_ORDER: readonly string[] = [
  NOTIFICATION_EVENT.COMPLIANCE_HOLD,
  NOTIFICATION_EVENT.ACCESS_REQUESTED,
  NOTIFICATION_EVENT.NDA_PENDING,
  NOTIFICATION_EVENT.STEP_ASSIGNED,
];

const ACTION_LABEL: Record<string, string> = {
  [NOTIFICATION_EVENT.COMPLIANCE_HOLD]: 'Review hold',
  [NOTIFICATION_EVENT.ACCESS_REQUESTED]: 'Approve',
  [NOTIFICATION_EVENT.NDA_PENDING]: 'Review NDA',
  [NOTIFICATION_EVENT.STEP_ASSIGNED]: 'Open step',
};

function phaseSegment(index: number, phaseIndex: number | null): PhaseSegment {
  if (phaseIndex == null || index > phaseIndex) return 'todo';
  return index < phaseIndex ? 'done' : 'current';
}

function phaseMeter(phaseIndex: number | null): PhaseSegment[] {
  return MVP_DEAL_RAIL.map((p) => phaseSegment(p.index, phaseIndex));
}

export function dealRow(deal: ListedDeal, needsYou: readonly NeedsYouRow[] = []): DealRow {
  const current = deal.currentStep;
  const stepId = current === null ? null : (current?.stepId ?? deal.cursorStepId);
  const catalog = stepId ? catalogFor(stepId) : null;
  const phaseIndex =
    current?.phaseIndex ??
    (stepId ? phaseForStep(stepId, MVP_DEAL_RAIL)?.index : undefined) ??
    phaseForStep(deal.cursorStepId, MVP_DEAL_RAIL)?.index ??
    null;
  const phase = MVP_DEAL_RAIL.find((p) => p.index === phaseIndex)?.name ?? deal.status;

  const progress = deal.phaseProgress?.find((p) => p.phaseIndex === phaseIndex);
  const phasePercent =
    current !== null && progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  const stepSeq = current ? current.seq : (catalog?.seq ?? null);
  const position = stepId != null ? MVP_POSITION.get(stepId) : undefined;
  // A custom step sorts at the start of its phase; no step sorts last.
  const phaseStart = MVP_STEPS.findIndex((s) => phaseForStep(s.id, MVP_DEAL_RAIL)?.index === phaseIndex);
  const progressKey = position ?? (current === null || phaseStart < 0 ? -1 : phaseStart);

  const needsYouCount = needsYou.filter(
    (n) => (n.dealCode != null && n.dealCode === deal.code) || (n.dealCode == null && n.codename === deal.codename),
  ).length;

  return {
    dealId: deal.id,
    code: deal.code,
    codename: deal.codename,
    phaseIndex,
    phase,
    phasePercent,
    meter: phaseMeter(phaseIndex),
    stepSeq,
    stepTitle:
      current === null ? 'No active step' : (current?.title ?? catalog?.title ?? current?.stepId ?? deal.status),
    hasCurrentStep: current !== null,
    assigneeName: current?.assignee?.name ?? null,
    running: current?.benchRunStatus === BENCH_RUN_STATUS.RUNNING,
    href: railHref(deal.code || deal.id, stepSeq),
    targetCloseDate: deal.targetCloseDate ?? null,
    needsYou: needsYouCount,
    category: deal.lifecycleCategory ?? 'live',
    progressKey,
  };
}

/** One row per deal, furthest along first. */
export function dealRows(deals: readonly ListedDeal[], needsYou: readonly NeedsYouRow[] = []): DealRow[] {
  return deals
    .map((d) => dealRow(d, needsYou))
    .sort((a, b) => b.progressKey - a.progressKey || a.codename.localeCompare(b.codename));
}

/** Only real work in flight: the current step's draft run is running. */
export function runningRows(rows: readonly DealRow[]): DealRow[] {
  return rows.filter((r) => r.running);
}

/** Local calendar day as YYYY-MM-DD (target close dates are calendar days). */
export function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Deals whose target close date is today. The only date the platform holds. */
export function dueTodayRows(rows: readonly DealRow[], now: Date = new Date()): DealRow[] {
  const today = localDayKey(now);
  return rows.filter((r) => r.category === 'live' && r.targetCloseDate?.slice(0, 10) === today);
}

/** Where an item's action goes. An access request is decided in place, so it has none. */
function itemHref(n: AppNotification, code: string | null, stepSeq: number | null): string | null {
  if (n.event_type === NOTIFICATION_EVENT.ACCESS_REQUESTED) return null;
  if (typeof n.payload.href === 'string') return storedHrefWithDealCode(n) ?? n.payload.href;
  return code ? railHref(code, stepSeq) : null;
}

function accessRequestTitle(actor: string | null, destination: string | null): string {
  if (actor && destination) return `${actor} asks for access to ${destination}`;
  if (destination) return `Access requested to ${destination}`;
  if (actor) return `${actor} asks for access`;
  return notificationEventLabel(NOTIFICATION_EVENT.ACCESS_REQUESTED);
}

export function needsYouRows(notifications: readonly AppNotification[]): NeedsYouRow[] {
  return notifications
    .filter((n) => !n.read_at && NEEDS_YOU_ORDER.includes(n.event_type))
    // Array sort is stable, so items of one kind keep their notification order.
    .sort((a, b) => NEEDS_YOU_ORDER.indexOf(a.event_type) - NEEDS_YOU_ORDER.indexOf(b.event_type))
    .map((n): NeedsYouRow => {
      const label = notificationEventLabel(n.event_type);
      const stepId = typeof n.payload.stepId === 'string' ? n.payload.stepId : null;
      const stepTitle = typeof n.payload.stepTitle === 'string' ? n.payload.stepTitle : null;
      const stepSeq = stepId ? (MVP_STEPS.find((s) => s.id === stepId)?.seq ?? null) : null;
      const code = typeof n.payload.code === 'string' ? n.payload.code : null;
      const actor = typeof n.payload.actor === 'string' ? n.payload.actor : null;
      const destinationLabel =
        typeof n.payload.destinationLabel === 'string' ? n.payload.destinationLabel : null;
      const requestId = typeof n.payload.requestId === 'string' ? n.payload.requestId : null;
      const isAccessRequest = n.event_type === NOTIFICATION_EVENT.ACCESS_REQUESTED;
      // An access request names who asked for what in its title, so the meta
      // never repeats it; other items carry their label unless it IS the title.
      const title = isAccessRequest ? accessRequestTitle(actor, destinationLabel) : (stepTitle ?? label);
      const metaParts: string[] = [];
      if (title !== label) metaParts.push(label);
      if (actor && !isAccessRequest) metaParts.push(`by ${actor}`);
      metaParts.push(relativeTime(n.created_at));
      const href = itemHref(n, code, stepSeq);
      return {
        id: n.id,
        title,
        codename: typeof n.payload.codename === 'string' ? n.payload.codename : null,
        dealCode: code,
        meta: metaParts.join(' · '),
        href,
        eventType: n.event_type,
        requestId,
        destinationLabel,
        actor,
        actionLabel: isAccessRequest || href ? (ACTION_LABEL[n.event_type] ?? 'Open') : MARK_READ_LABEL,
      };
    });
}
