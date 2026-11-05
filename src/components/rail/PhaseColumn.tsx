'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Plus } from 'lucide-react';

import { overlayTransition } from '@/components/overlay/motion';
import { stepTitle } from '@/lib/rail/projectRail';
import type { PhaseSummary } from './railBoardModel';
import { StationStatus, StepMarker } from './StepCard';

/** Up to this many faces show on a phase header; the rest read as "+N". */
const FACES_SHOWN = 3;

function PhasePeople({ people }: { people: PhaseSummary['people'] }) {
  // Unknown after a failed owners read: say nothing rather than "No one assigned".
  if (people === null) return null;
  if (people.length === 0) {
    return (
      <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">No one assigned</p>
    );
  }
  const shown = people.slice(0, FACES_SHOWN);
  const more = people.length - shown.length;
  return (
    <div className="flex min-w-0 items-center gap-[var(--space-2)]">
      <span aria-hidden className="flex shrink-0 -space-x-1.5">
        {shown.map((person) => (
          <span
            key={person.id}
            title={person.name}
            className="flex size-5 items-center justify-center rounded-full bg-[var(--surface-warm)] text-[length:var(--text-xxs)] font-semibold text-[var(--ink-secondary)] ring-2 ring-[var(--surface-subtle)]"
          >
            {person.initials}
          </span>
        ))}
      </span>
      <p className="min-w-0 truncate text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        {shown.map((person) => person.name).join(', ')}
        {more > 0 ? ` +${more}` : ''}
      </p>
    </div>
  );
}

/**
 * The plus on the dashed track under a step: shows while the step above or the
 * track itself is hovered, or on focus. Where nothing can hover it stays quiet
 * but visible. Its parent needs `group/row` and `relative`.
 */
export function StepGapAdd({
  label,
  tabIndex,
  onAdd,
}: {
  label: string;
  tabIndex: number;
  onAdd: () => void;
}) {
  return (
    <div className="group/gap absolute inset-x-0 -bottom-[var(--space-6)] z-10 flex h-[var(--space-6)] items-center justify-center">
      <button
        type="button"
        aria-label={label}
        title={label}
        tabIndex={tabIndex}
        onClick={onAdd}
        className="flex size-6 items-center justify-center rounded-full text-[var(--ink)] opacity-0 outline-offset-1 transition-opacity group-hover/gap:opacity-100 group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--accent)] [@media(hover:none)]:opacity-60"
      >
        <span className="flex size-5 items-center justify-center rounded-full border border-[var(--stroke-strong)] bg-[var(--surface)] shadow-[var(--elev-2)] group-hover/gap:border-[var(--accent)]">
          <Plus className="size-3" aria-hidden="true" />
        </span>
      </button>
    </div>
  );
}

/** A run of closed steps folded into one row: "10 done", stacked like cards. */
export type PhaseFold = {
  count: number;
  open: boolean;
  onToggle: () => void;
  /** While folded: add a step after the run, on the track under the row. */
  onAddAfter?: () => void;
};

const FOLD_EDGE =
  'absolute h-full rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--surface-raised)] transition-[bottom,opacity] duration-300 motion-reduce:transition-none';

/**
 * The row a run of steps folds into, with two edges of the folded cards peeking
 * below it. Its parent needs `relative`.
 */
export function FoldToggle({
  label,
  mark,
  open,
  onToggle,
  controls,
}: {
  label: string;
  mark: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <>
      {/* The cards folded underneath: two edges peeking below the row, tucking
          back behind it as the cards open. */}
      <span aria-hidden>
        <span className={`${FOLD_EDGE} inset-x-[2.4%] ${open ? 'bottom-0 opacity-0' : '-bottom-[6px]'}`} />
        <span className={`${FOLD_EDGE} inset-x-[1.2%] ${open ? 'bottom-0 opacity-0' : '-bottom-[3px]'}`} />
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={controls}
        className="relative flex h-8 w-full items-center gap-[var(--space-2)] rounded-[var(--radius-control)] border border-[var(--stroke)] bg-[var(--surface-raised)] px-[var(--space-3)] text-left outline-offset-2 transition-colors hover:border-[var(--stroke-strong)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
      >
        {mark}
        <span className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">{label}</span>
        <ChevronDown
          aria-hidden
          size={14}
          strokeWidth={1.75}
          className={`ml-auto text-[var(--ink-tertiary)] transition-transform duration-300 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
    </>
  );
}

/** The steps before the deal opened here: the row a run of them folds into. */
export function PriorFoldMark() {
  return <StepMarker state="prior" />;
}

function DoneFold({ fold, controls }: { fold: PhaseFold; controls: string }) {
  return (
    <div className="group/row relative mb-[var(--space-6)] after:pointer-events-none after:absolute after:-bottom-[var(--space-6)] after:left-1/2 after:h-[var(--space-6)] after:border-l after:border-dashed after:border-[var(--stroke-strong)]">
      {fold.onAddAfter ? (
        <StepGapAdd label="Add a step after the done steps" tabIndex={0} onAdd={fold.onAddAfter} />
      ) : null}
      <FoldToggle
        label={`${fold.count} done`}
        mark={<StationStatus state="done" />}
        open={fold.open}
        onToggle={fold.onToggle}
        controls={controls}
      />
    </div>
  );
}

/**
 * PhaseColumn: one phase on the rail board. A compact header (name, how much
 * is done, who is on it) over a lane that holds the phase's steps as separate
 * cards, like a board column. The header's name is the toggle; the whole
 * header is its hit area. A run of closed steps can fold into one row.
 */
export function PhaseColumn({
  summary,
  expanded,
  onToggle,
  buttonRef,
  onKeyDown,
  fold,
  footer,
  headerExtra,
  children,
}: {
  summary: PhaseSummary;
  expanded: boolean;
  onToggle: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  /** Closed steps folded above the stack, when there is a run worth folding. */
  fold?: PhaseFold | null;
  /** Under the open stack: the column's own action (Add new step). */
  footer?: React.ReactNode;
  /** Under the people on the header: the phase's own shortcuts. */
  headerExtra?: React.ReactNode;
  /** The phase's step cards, in rail order. */
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  const { phase, done, total, pct, complete, currentStep } = summary;
  const isCurrent = currentStep !== null;
  const stackId = `rail-phase-${phase.index}-steps`;
  const statsId = `rail-phase-${phase.index}-stats`;
  const status = complete ? 'done' : isCurrent || done > 0 ? 'active' : 'todo';
  return (
    <li
      data-phase-column={phase.index}
      data-current={isCurrent ? 'true' : undefined}
      className="flex min-w-0 flex-col md:w-[262px] md:shrink-0"
    >
      <div
        className={[
          'relative rounded-[12px] border bg-[var(--surface-subtle)] px-[var(--space-3)] pt-[var(--space-3)] transition-[border-color,box-shadow] duration-150 focus-within:shadow-[var(--elev-2)] hover:shadow-[var(--elev-2)]',
          isCurrent ? 'border-[var(--accent)]' : 'border-[var(--stroke-strong)]',
          expanded ? 'pb-[var(--space-8)]' : 'pb-[var(--space-3)]',
        ].join(' ')}
      >
        <div className="flex items-start gap-[var(--space-2)]">
          <h3 className="min-w-0 flex-1 text-[length:var(--text-sm)] font-medium leading-snug text-[var(--ink)]">
            <button
              type="button"
              ref={buttonRef}
              onClick={onToggle}
              onKeyDown={onKeyDown}
              aria-expanded={expanded}
              aria-controls={stackId}
              aria-describedby={statsId}
              className="text-left outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--accent)]"
            >
              {phase.name}
            </button>
          </h3>
          {/* The status mark and the rotated chevron paint over the toggle's hit
              area: clicks pass through them to the toggle. */}
          <span aria-hidden className="pointer-events-none flex shrink-0 items-center gap-[var(--space-2)]">
            <span className="text-[length:var(--text-sm)] font-medium tabular-nums text-[var(--ink-secondary)]">
              {done}/{total}
            </span>
            <StationStatus state={status} />
          </span>
          <ChevronDown
            aria-hidden
            size={14}
            strokeWidth={1.75}
            className={`pointer-events-none mt-0.5 shrink-0 text-[var(--ink-tertiary)] transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
          />
        </div>

        {/* What the toggle's description reads; the header shows it as "3/23". */}
        <div id={statsId} className="sr-only">
          <span>{pct}%</span> <span>{done} of {total} done</span>
          {currentStep ? (
            <p>
              Current step
              <span>{stepTitle(currentStep)}</span>
            </p>
          ) : null}
        </div>

        <div className="mt-[var(--space-1)]">
          <PhasePeople people={summary.people} />
        </div>
        {headerExtra}
      </div>

      {expanded ? (
        <div className="relative -mt-[var(--space-5)] rounded-[12px] bg-[var(--surface-raised)] px-[var(--space-3)] pt-[var(--space-3)] shadow-[0_-4px_2px_rgb(0_0_0/0.04)]">
          {fold && fold.count > 0 ? <DoneFold fold={fold} controls={stackId} /> : null}
          <motion.ol
            id={stackId}
            aria-label={`${summary.shortName} steps`}
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={overlayTransition}
            data-step-stack=""
            // The lane grows with its cards and the page scrolls; a long run
            // of closed steps folds instead of scrolling inside the column.
            className="relative flex flex-col gap-[var(--space-6)] md:p-0.5"
          >
            {children}
          </motion.ol>
          {footer ? <div className="py-[var(--space-3)]">{footer}</div> : <div className="h-[var(--space-3)]" />}
        </div>
      ) : null}
    </li>
  );
}

export default PhaseColumn;
