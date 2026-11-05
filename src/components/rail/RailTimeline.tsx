'use client';

import * as React from 'react';

import { PreviewBanner } from '@/components/overlay';
import type { StepOwnerSummary } from '@/lib/rail/boardContract';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import type { StepDates } from '@/lib/rail/railPreview';
import { shortPhaseName } from './railBoardModel';
import { Face, formatStepDay } from './RailDependencyView';
import { STEP_STATE_LABEL, type StepState } from './stepState';

const DAY_MS = 86_400_000;
/** Pixels per day. */
const DAY_WIDTH = 4.2;
const LABEL_WIDTH = 230;
const MARK_WIDTH = 14;

/** A calendar day stored as YYYY-MM-DD, as a whole number in UTC so it never shifts. */
export function dayNumber(day: string): number {
  const [year, month, date] = day.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, date) / DAY_MS);
}

const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** The first of each month the timeline covers, with the year on January and on the first month. */
export function timelineMonths(start: number, end: number): { day: number; label: string }[] {
  const months: { day: number; label: string }[] = [];
  const first = new Date(start * DAY_MS);
  let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1);
  while (cursor / DAY_MS <= end) {
    const date = new Date(cursor);
    const showYear = months.length === 0 || date.getUTCMonth() === 0;
    months.push({
      day: Math.floor(cursor / DAY_MS),
      label: `${monthLabel.format(date)}${showYear ? ` ${date.getUTCFullYear()}` : ''}`,
    });
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return months;
}

export type TimelineBar = { start: number; end: number };

/**
 * Where a step's bar sits, from the dates set for it: start to target, or one
 * mark on the target when no start is set. A step with no dates that has closed
 * marks the day it closed. Otherwise it has no bar.
 */
export function timelineBar(dates: StepDates | undefined, closedAt: string | null | undefined): TimelineBar | null {
  if (dates?.target) {
    const end = dayNumber(dates.target);
    return { start: dates.start ? dayNumber(dates.start) : end, end };
  }
  if (closedAt) {
    const day = dayNumber(closedAt);
    return { start: day, end: day };
  }
  return null;
}

const BAR_TONE: Partial<Record<StepState, string>> = {
  done: 'border-transparent bg-[var(--positive-fill)] text-[var(--positive-deep)]',
  active: 'border-transparent bg-[var(--accent)] text-[var(--ink-on-dark)]',
};
const BAR_DEFAULT = 'border-[var(--stroke-strong)] bg-[var(--surface-subtle)] text-[var(--ink-secondary)]';

/**
 * The timeline view: a light Gantt of the same steps, grouped by phase. Bars come
 * from the dates set in this browser (handoff E4) and owners from the deal; a
 * step with no dates says so and offers to set them. Nothing reaches the deal.
 */
export function RailTimeline({
  phases,
  steps,
  stateFor,
  dates,
  owners,
  closedAtFor,
  targetCloseDate,
  numberOf,
  onOpenStep,
  onEditDates,
  onReset,
}: {
  phases: readonly { index: number; name: string }[];
  /** The steps shown, in rail order. */
  steps: readonly ProjectRailStep[];
  stateFor: (step: ProjectRailStep) => StepState;
  dates: Readonly<Record<string, StepDates>>;
  owners?: ReadonlyMap<string, StepOwnerSummary>;
  /** When a closed step closed, from its record. */
  closedAtFor: (step: ProjectRailStep) => string | null | undefined;
  targetCloseDate?: string | null;
  numberOf: (step: ProjectRailStep) => string;
  onOpenStep: (id: string) => void;
  onEditDates: (step: ProjectRailStep) => void;
  onReset: () => void;
}) {
  const [today] = React.useState(() => {
    const now = new Date();
    return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
  });
  const targetClose = targetCloseDate ? dayNumber(targetCloseDate) : null;

  const bars = new Map(
    steps.map((step) => [step.id, timelineBar(dates[step.id], closedAtFor(step))] as const),
  );
  const days = [today];
  if (targetClose !== null) days.push(targetClose);
  for (const step of steps) {
    const bar = bars.get(step.id);
    if (bar) days.push(bar.start, bar.end);
    if (dates[step.id]?.dropDead) days.push(dayNumber(dates[step.id].dropDead as string));
  }
  const rangeStart = Math.min(...days) - 21;
  const rangeEnd = Math.max(Math.max(...days) + 30, today + 120);
  const x = (day: number) => Math.round((day - rangeStart) * DAY_WIDTH);
  const width = x(rangeEnd);
  const months = timelineMonths(rangeStart, rangeEnd).filter((month) => month.day >= rangeStart);

  // Opens with today in view.
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const todayX = x(today);
  React.useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollLeft = Math.max(0, todayX - 120);
  }, [todayX]);

  const markers = (
    <>
      {months.map((month) => (
        <span
          key={month.day}
          aria-hidden
          className="absolute inset-y-0 border-l border-[var(--stroke)]"
          style={{ left: x(month.day) }}
        />
      ))}
      <span aria-hidden className="absolute inset-y-0 z-[1] border-l-[1.5px] border-[var(--accent)]" style={{ left: x(today) }} />
      {targetClose !== null ? (
        <span aria-hidden className="absolute inset-y-0 z-[1] border-l-[1.5px] border-dashed border-[var(--ink-secondary)]" style={{ left: x(targetClose) }} />
      ) : null}
    </>
  );

  return (
    <section aria-label="Timeline" className="flex flex-col gap-[var(--space-3)]">
      {/* Preview: handoff E4 "Step dependencies, per-step dates and \"started\" facts". */}
      <PreviewBanner onReset={onReset} />
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        A light Gantt view of the same steps. Parallel work shows as overlapping bars. The dates are the ones you set; the
        deal itself stores only the target close.
      </p>
      <ul
        aria-label="Timeline key"
        className="flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
      >
        <li className="flex items-center gap-[var(--space-1)]">
          <span aria-hidden className="block h-2.5 w-[18px] rounded-[3px] bg-[var(--positive-fill)]" /> Done
        </li>
        <li className="flex items-center gap-[var(--space-1)]">
          <span aria-hidden className="block h-2.5 w-[18px] rounded-[3px] bg-[var(--accent)]" /> Current step
        </li>
        <li className="flex items-center gap-[var(--space-1)]">
          <span aria-hidden className="block h-2.5 w-[18px] rounded-[3px] border border-[var(--stroke-strong)] bg-[var(--surface-subtle)]" /> Not done
        </li>
        <li className="flex items-center gap-[var(--space-1)]">
          <span aria-hidden className="block size-2 rotate-45 bg-[var(--negative)]" /> Step drop-dead
        </li>
        <li>Today {formatStepDay(new Date(today * DAY_MS).toISOString().slice(0, 10))}</li>
        <li>{targetCloseDate ? `Target close ${formatStepDay(targetCloseDate)}` : 'No target close set'}</li>
      </ul>

      <div
        ref={scrollerRef}
        tabIndex={0}
        role="region"
        aria-label="Timeline chart, scrolls sideways"
        className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        <div className="relative w-max min-w-full pb-[var(--space-2)]">
          <div className="flex border-b border-[var(--stroke)]">
            <div
              className="sticky left-0 z-[4] flex shrink-0 items-end bg-[var(--surface)] px-[var(--space-3)] pb-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
              style={{ width: LABEL_WIDTH }}
            >
              Step
            </div>
            <div className="relative h-[52px] shrink-0" style={{ width }}>
              {months.map((month) => (
                <span
                  key={month.day}
                  className="absolute inset-y-0 whitespace-nowrap border-l border-[var(--stroke)] px-1.5 pt-7 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
                  style={{ left: x(month.day) }}
                >
                  {month.label}
                </span>
              ))}
              <span
                className="absolute top-0.5 z-[5] -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--accent)] bg-[var(--surface)] px-1.5 text-[length:var(--text-xxs)] font-semibold text-[var(--accent)]"
                style={{ left: x(today) }}
              >
                Today
              </span>
              {targetClose !== null ? (
                <span
                  className="absolute top-0.5 z-[5] -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--stroke-strong)] bg-[var(--surface)] px-1.5 text-[length:var(--text-xxs)] font-semibold text-[var(--ink-secondary)]"
                  style={{ left: x(targetClose) }}
                >
                  Target close
                </span>
              ) : null}
            </div>
          </div>

          {steps.length === 0 ? (
            <p className="px-[var(--space-3)] py-[var(--space-4)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              No steps in this view.
            </p>
          ) : null}

          {phases.map((phase) => {
            const inPhase = steps.filter((step) => step.phaseIndex === phase.index);
            if (inPhase.length === 0) return null;
            return (
              <React.Fragment key={phase.index}>
                <div className="flex border-t border-[var(--stroke)] bg-[var(--surface-raised)]">
                  <div
                    className="sticky left-0 z-[4] flex shrink-0 items-center bg-[var(--surface-raised)] px-[var(--space-3)] py-1.5 text-[length:var(--text-sm)] font-semibold text-[var(--ink)]"
                    style={{ width: LABEL_WIDTH }}
                  >
                    <span className="truncate" title={phase.name}>{shortPhaseName(phase.name)}</span>
                  </div>
                  <div className="relative min-h-[30px] shrink-0" style={{ width }}>
                    {markers}
                  </div>
                </div>
                {inPhase.map((step) => {
                  const state = stateFor(step);
                  const bar = bars.get(step.id);
                  const stepDates = dates[step.id];
                  const owner = owners?.get(step.stepId)?.owner;
                  const barWidth = bar ? Math.max(MARK_WIDTH, x(bar.end) - x(bar.start)) : 0;
                  return (
                    <div key={step.id} data-timeline-step={step.stepId} className="flex">
                      <div
                        className="sticky left-0 z-[4] flex shrink-0 items-center gap-[var(--space-2)] bg-[var(--surface)] px-[var(--space-3)] py-1"
                        style={{ width: LABEL_WIDTH }}
                      >
                        <Face owner={owner} />
                        <button
                          type="button"
                          onClick={() => onOpenStep(step.id)}
                          title={`${numberOf(step)} · ${stepTitle(step)}`}
                          className="min-w-0 truncate rounded-[var(--radius-input)] text-left text-[length:var(--text-sm)] text-[var(--ink)] outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          {stepTitle(step)}
                        </button>
                      </div>
                      <div className="relative h-[34px] shrink-0" style={{ width }}>
                        {markers}
                        {bar ? (
                          <button
                            type="button"
                            onClick={() => onEditDates(step)}
                            aria-label={`Set dates for ${stepTitle(step)}, ${STEP_STATE_LABEL[state]}`}
                            title={stepDates?.target ? `${stepTitle(step)}, target ${formatStepDay(stepDates.target)}` : stepTitle(step)}
                            className={[
                              'absolute top-[7px] z-[2] flex h-5 items-center overflow-hidden whitespace-nowrap rounded-[5px] border px-1.5 text-[length:var(--text-xxs)] font-semibold outline-offset-1 focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
                              BAR_TONE[state] ?? BAR_DEFAULT,
                            ].join(' ')}
                            style={{ left: x(bar.start), width: barWidth }}
                          >
                            {owner && barWidth >= 28 ? owner.initials : ''}
                          </button>
                        ) : stepDates?.dropDead ? null : (
                          <button
                            type="button"
                            onClick={() => onEditDates(step)}
                            aria-label={`Set dates for ${stepTitle(step)}, no dates yet`}
                            className="absolute top-[7px] z-[2] flex h-5 w-[120px] items-center overflow-hidden whitespace-nowrap rounded-[5px] border border-[var(--stroke-strong)] bg-[var(--surface-subtle)] px-1.5 text-[length:var(--text-xxs)] font-semibold text-[var(--ink-secondary)] outline-offset-1 hover:border-[var(--ink-quiet)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                            style={{ left: x(today) }}
                          >
                            No dates yet
                          </button>
                        )}
                        {stepDates?.dropDead ? (
                          <button
                            type="button"
                            onClick={() => onEditDates(step)}
                            aria-label={`Drop-dead ${formatStepDay(stepDates.dropDead)} for ${stepTitle(step)}`}
                            title={`Drop-dead ${formatStepDay(stepDates.dropDead)}`}
                            className="absolute top-[10px] z-[3] size-[13px] -translate-x-1/2 rotate-45 border-2 border-[var(--surface)] bg-[var(--negative)]"
                            style={{ left: x(dayNumber(stepDates.dropDead)) }}
                          />
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export default RailTimeline;
