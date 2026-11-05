'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { LandPlot } from 'lucide-react';

import { GATE0_STEP_ID_SET } from '@/lib/rail/gate0';
import type { FixtureDeal } from '@/lib/rail/deals';
import type { SortableHandle } from '@/lib/rail/boardContract';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import { ON_RECORD, stepCompletedBy } from '@/lib/rail/stepRecords';
import { FoldToggle, PhaseColumn, PriorFoldMark, StepGapAdd } from './PhaseColumn';
import type { PhaseSummary } from './railBoardModel';
import type { RailRunState } from './railRunState';
import { StepCard } from './StepCard';
import type { StepState } from './stepState';

/**
 * What a sortable wrapper hands a card: the item's node ref and transform style
 * land on the card's own `<li>`, the drag handle on the card's button, so a
 * sortable list nests validly (`<ol>` > `<li>`) without an extra wrapper.
 */
export type StepCardItem = {
  ref?: React.Ref<HTMLLIElement>;
  style?: React.CSSProperties;
  handle?: SortableHandle;
};

/** Renders one step card as its `<li>`; `RailBoard` passes it to `renderStack`. */
export type RenderStepCard = (step: ProjectRailStep, item?: StepCardItem) => React.ReactNode;

// The dashed track under a card belongs to its own row, so the row's plus sits on top of it.
const ROW_CLASS =
  'group/row relative isolate [&:has(+li)]:after:pointer-events-none [&:has(+li)]:after:absolute [&:has(+li)]:after:-bottom-[var(--space-6)] [&:has(+li)]:after:left-1/2 [&:has(+li)]:after:h-[var(--space-6)] [&:has(+li)]:after:border-l [&:has(+li)]:after:border-dashed [&:has(+li)]:after:border-[var(--stroke-strong)]';

/** Closed, a row also takes back the stack's gap under it (`--space-6`). */
const FOLD_ROW_CLOSED = { height: 0, opacity: 0, marginBottom: -24 };
const FOLD_ROW_OPEN = { height: 'auto', opacity: 1, marginBottom: 0 };
const FOLD_ROW_TRANSITION = { duration: 0.32, ease: [0.4, 0, 0.2, 1] } as const;

/** A card under a column's "N done" row: eases open and closed with the fold. */
function FoldRow({ item, children }: { item?: StepCardItem; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  // Clip only while the height animates, so a settled row never clips a focus
  // ring, a card's shadow or the plus on the track under it.
  const [animating, setAnimating] = React.useState(false);
  return (
    <motion.li
      ref={item?.ref}
      style={item?.style}
      initial={FOLD_ROW_CLOSED}
      animate={FOLD_ROW_OPEN}
      exit={FOLD_ROW_CLOSED}
      transition={reduce ? { duration: 0 } : FOLD_ROW_TRANSITION}
      onAnimationStart={() => setAnimating(true)}
      onAnimationComplete={() => setAnimating(false)}
      className={animating ? `${ROW_CLASS} overflow-hidden` : ROW_CLASS}
    >
      {children}
    </motion.li>
  );
}

export type RailBoardProps = {
  summaries: readonly PhaseSummary[];
  /** Every active step in rail order: numbering reads from here. */
  steps: readonly ProjectRailStep[];
  stateFor: (step: ProjectRailStep) => StepState;
  run: RailRunState;
  /** Active deal: drives "Completed by" on done steps. */
  deal: FixtureDeal;
  expanded: ReadonlySet<number>;
  onTogglePhase: (phaseIndex: number) => void;
  /** Open a step over the board. `from` is the card pressed. */
  onOpenStep: (id: string, from: Element | null) => void;
  /** Move keyboard focus back after a step closes: its card, else its phase's header. */
  focusPhase?: { phaseIndex: number; stepId?: string; nonce: number } | null;
  /** The deal cursor. The board opens scrolled to it once per deal. */
  currentStepId?: string | null;
  /** Whether the opening scroll is still owed (the parent holds it per deal). */
  openAtCursor?: boolean;
  onOpenedAtCursor?: () => void;
  /**
   * The steps a phase shows, in the order shown: a view filter drops some, a
   * preview reorder moves them. Defaults to the phase's steps in rail order.
   * Keyboard order and each column's tab stop follow this list.
   */
  stepsFor?: (summary: PhaseSummary) => readonly ProjectRailStep[];
  /**
   * Lays out a phase's stack from `shown` (= `stepsFor(summary)`). Defaults to
   * `shown.map((step) => renderCard(step))`; a reorder view wraps the same
   * cards in its sortable list, passing each item's ref, style and handle.
   */
  renderStack?: (
    summary: PhaseSummary,
    renderCard: RenderStepCard,
    shown: readonly ProjectRailStep[],
  ) => React.ReactNode;
  /** Extra lines on a step card under its title (owner, activity). */
  stepFooter?: (step: ProjectRailStep) => React.ReactNode;
  /** A step to highlight on the board: the one just added. */
  highlightStepId?: string | null;
  /** Under an open column's stack: its own action (Add new step). */
  columnFooter?: (summary: PhaseSummary) => React.ReactNode;
  /** Phases whose "N done" row is unfolded. The parent holds it: the board
   *  unmounts while a step is zoomed, and a fold stays open across that. */
  unfolded?: ReadonlySet<number>;
  onToggleFold?: (phaseIndex: number) => void;
  /** Phases whose run of steps from before the deal is unfolded. */
  unfoldedPrior?: ReadonlySet<number>;
  onTogglePriorFold?: (phaseIndex: number) => void;
  /** Offers a plus on the dashed track under each card but a column's last
   *  (its footer adds there). Unset, the tracks are only lines. */
  onAddStepAfter?: (step: ProjectRailStep) => void;
  /** Whether a run of done steps folds. A search shows every match instead. */
  foldDone?: boolean;
  /** Under the people on a phase's header. */
  phaseHeaderExtra?: (summary: PhaseSummary) => React.ReactNode;
  /** Over the columns: the lines the dependency view draws. */
  overlay?: React.ReactNode;
};

const NONE_UNFOLDED: ReadonlySet<number> = new Set();

/** A run shorter than this stays as cards: folding one card saves nothing. */
export const FOLD_MIN_STEPS = 2;

/**
 * The steps a column folds into one "N done" row: the done run at its top,
 * when the run is long enough and the phase still has a step open. Only done
 * steps fold: a skipped or pre-entry step was not done, so the row never counts
 * one, and it ends the run. A finished phase folds nothing.
 */
export function foldedSteps(
  shown: readonly ProjectRailStep[],
  stateFor: (step: ProjectRailStep) => StepState,
): ProjectRailStep[] {
  const hasOpen = shown.some((step) => {
    const state = stateFor(step);
    return state === 'active' || state === 'todo';
  });
  if (!hasOpen) return [];
  const firstNotDone = shown.findIndex((step) => stateFor(step) !== 'done');
  return firstNotDone < FOLD_MIN_STEPS ? [] : shown.slice(0, firstNotDone);
}

/**
 * The steps from before the deal opened here that fold into one row: the first
 * unbroken run of them in a column, when it is long enough.
 */
export function foldedPriorSteps(
  shown: readonly ProjectRailStep[],
  stateFor: (step: ProjectRailStep) => StepState,
): ProjectRailStep[] {
  const start = shown.findIndex((step) => stateFor(step) === 'prior');
  if (start < 0) return [];
  let end = start;
  while (end < shown.length && stateFor(shown[end]) === 'prior') end += 1;
  return end - start < FOLD_MIN_STEPS ? [] : shown.slice(start, end);
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('input, textarea, select') !== null;
}

/** Runs the focus move bound to the pressed key, if any, and claims the key. */
function moveFocusByKey(e: React.KeyboardEvent, keys: Record<string, () => void>): void {
  const move = keys[e.key];
  if (!move) return;
  e.preventDefault();
  move();
}

/**
 * RailBoard: the zoomed-out rail. Every phase left to right between the rail's
 * two ends, each a large card that expands into its steps stacked beneath,
 * like a board's columns. Below md the phases stack top to bottom.
 *
 * Keyboard: Tab stops on each phase card and once in each open column (the
 * card last focused there, else the deal's current step, else the first);
 * arrows move within a column (Up/Down) and across columns (Left/Right),
 * Home/End jump within a column, and 1 to 9 jump to that phase and open it.
 */
export function RailBoard({
  summaries,
  steps,
  stateFor,
  run,
  deal,
  expanded,
  onTogglePhase,
  onOpenStep,
  focusPhase,
  currentStepId,
  openAtCursor = true,
  onOpenedAtCursor,
  stepsFor,
  renderStack,
  stepFooter,
  highlightStepId = null,
  columnFooter,
  unfolded = NONE_UNFOLDED,
  onToggleFold,
  unfoldedPrior = NONE_UNFOLDED,
  onTogglePriorFold,
  onAddStepAfter,
  foldDone = true,
  phaseHeaderExtra,
  overlay,
}: RailBoardProps) {
  const phaseRefs = React.useRef(new Map<number, HTMLButtonElement>());
  const stepRefs = React.useRef(new Map<string, HTMLButtonElement>());

  // What each column shows, in the order shown: keyboard order follows this.
  // Folded cards stay in `shown` (a reorder keeps its indexes) but take no
  // focus until their column is unfolded.
  const visibleColumns = React.useMemo(
    () =>
      summaries.map((summary) => {
        const shown = stepsFor ? stepsFor(summary) : summary.steps;
        const foldable = foldDone ? foldedSteps(shown, stateFor) : [];
        const foldablePrior = foldDone ? foldedPriorSteps(shown, stateFor) : [];
        const priorOpen = unfoldedPrior.has(summary.phase.index);
        const doneOpen = unfolded.has(summary.phase.index);
        const hidden = new Set([
          ...(doneOpen ? [] : foldable),
          ...(priorOpen ? [] : foldablePrior),
        ].map((s) => s.id));
        return {
          summary,
          shown,
          foldable,
          doneOpen,
          foldablePrior,
          priorOpen,
          foldIds: new Set([...foldable, ...foldablePrior].map((s) => s.id)),
          hidden,
          phaseIndex: summary.phase.index,
          stepIds: expanded.has(summary.phase.index)
            ? shown.filter((s) => !hidden.has(s.id)).map((s) => s.id)
            : [],
        };
      }),
    [summaries, expanded, stepsFor, stateFor, unfolded, unfoldedPrior, foldDone],
  );

  // One tab stop per column: the card last focused there, else the deal's
  // current step, else the first card shown.
  const [lastFocused, setLastFocused] = React.useState<Record<number, string>>({});
  const tabStopFor = (column: (typeof visibleColumns)[number]): string | undefined => {
    const ids = column.stepIds;
    const remembered = lastFocused[column.phaseIndex];
    if (remembered && ids.includes(remembered)) return remembered;
    const current = column.summary.currentStep?.id;
    if (current && ids.includes(current)) return current;
    return ids[0];
  };

  // Closing a step lands keyboard focus on its card, in view, so the board stays
  // where the MD was; a card folded away falls back to its phase's header.
  React.useEffect(() => {
    if (!focusPhase) return;
    const el =
      (focusPhase.stepId ? stepRefs.current.get(focusPhase.stepId) : undefined) ??
      phaseRefs.current.get(focusPhase.phaseIndex);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({
      behavior: 'instant',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [focusPhase]);

  // Open where the deal is: on wide screens, scroll the board sideways to the
  // cursor's column and its list to the cursor's card, once per deal, instantly,
  // without moving focus or the page. Below md the page stays at the top with
  // the header in view.
  const openedAtCursor = React.useRef(false);
  React.useEffect(() => {
    if (!openAtCursor || openedAtCursor.current || !currentStepId) return;
    const el = stepRefs.current.get(currentStepId);
    if (!el) return;
    openedAtCursor.current = true;
    onOpenedAtCursor?.();
    const wide =
      typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 768px)').matches;
    const stack = el.closest<HTMLElement>('[data-step-stack]');
    if (!wide || !stack) return;
    const card = el.closest<HTMLElement>('li') ?? el;
    stack.scrollTop = Math.max(0, card.offsetTop - stack.clientHeight / 3);
    const board = el.closest<HTMLElement>('[data-rail-scroller]');
    const column = el.closest<HTMLElement>('[data-phase-column]');
    if (board && column) board.scrollLeft = Math.max(0, column.offsetLeft - 48);
  }, [currentStepId, openAtCursor, onOpenedAtCursor, expanded]);

  const focusPhaseAt = React.useCallback(
    (column: number) => {
      const target = visibleColumns[column];
      if (!target) return;
      phaseRefs.current.get(target.phaseIndex)?.focus();
    },
    [visibleColumns],
  );

  const focusStepAt = React.useCallback(
    (column: number, row: number) => {
      const target = visibleColumns[column];
      if (!target) return;
      const id = target.stepIds[Math.max(0, Math.min(target.stepIds.length - 1, row))];
      const el = id ? stepRefs.current.get(id) : undefined;
      if (el) el.focus();
      else focusPhaseAt(column);
    },
    [visibleColumns, focusPhaseAt],
  );

  const onPhaseKeyDown = (column: number) => (e: React.KeyboardEvent<HTMLButtonElement>) =>
    moveFocusByKey(e, {
      ArrowLeft: () => focusPhaseAt(Math.max(0, column - 1)),
      ArrowRight: () => focusPhaseAt(Math.min(visibleColumns.length - 1, column + 1)),
      ArrowDown: () => focusStepAt(column, 0),
    });

  const onStepKeyDown =
    (column: number, row: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const last = (visibleColumns[column]?.stepIds.length ?? 1) - 1;
      const across = (delta: number) => {
        const next = column + delta;
        if (next < 0 || next >= visibleColumns.length) return;
        if (visibleColumns[next].stepIds.length > 0) focusStepAt(next, row);
        else focusPhaseAt(next);
      };
      moveFocusByKey(e, {
        ArrowDown: () => focusStepAt(column, Math.min(last, row + 1)),
        ArrowUp: () => (row === 0 ? focusPhaseAt(column) : focusStepAt(column, row - 1)),
        ArrowLeft: () => across(-1),
        ArrowRight: () => across(1),
        Home: () => focusStepAt(column, 0),
        End: () => focusStepAt(column, last),
      });
    };

  // Quick jump: a digit opens and focuses that phase, from anywhere on the board.
  const onBoardKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const summary = summaries[Number(e.key) - 1];
    if (!summary) return;
    e.preventDefault();
    if (!expanded.has(summary.phase.index)) onTogglePhase(summary.phase.index);
    phaseRefs.current.get(summary.phase.index)?.focus();
  };

  const completedByFor = (step: ProjectRailStep, state: StepState): string | null => {
    if (state !== 'done' && state !== 'skipped') return null;
    return (
      // The deal's own creator when it names one, never the signed-in viewer
      // (handoff E32); a Gate 0 step with no name reads "On record".
      stepCompletedBy(deal, step.stepId, step.skip ?? undefined) ||
      (state === 'done' && GATE0_STEP_ID_SET.has(step.stepId) ? ON_RECORD : null)
    );
  };

  return (
    <section aria-label="Rail overview" onKeyDown={onBoardKeyDown}>
      <div data-rail-scroller className="relative md:overflow-x-auto md:pb-[var(--space-3)]">
        {/* As wide as its columns, so the End mark follows the last one instead of sitting under it. */}
        <div className="relative flex flex-col gap-[var(--space-5)] md:w-max md:min-w-full md:flex-row md:items-start">
          {/* The rail itself: one line from end to end, behind the phase headers. */}
          <span
            aria-hidden
            className="absolute left-[var(--space-3)] right-[var(--space-3)] top-[12px] hidden border-t border-dashed border-[var(--stroke-strong)] md:block"
          />
          <RailTerminal end="start" />
          <ol className="flex min-w-0 flex-1 flex-col gap-[var(--space-5)] md:flex-row md:items-start">
            {visibleColumns.map((visible, column) => {
              const { summary, hidden, foldIds, foldable, doneOpen, foldablePrior, priorOpen } = visible;
              const tabStop = tabStopFor(visible);
              const renderCard: RenderStepCard = (step, item) => {
                const state = stateFor(step);
                const receipts = run.receipts[step.stepId];
                const row = visible.stepIds.indexOf(step.id);
                const body = (
                  <>
                    <StepCard
                      step={step}
                      state={state}
                      receipt={receipts?.[receipts.length - 1]}
                      completedBy={completedByFor(step, state)}
                      completedAt={
                        state === 'done'
                          ? deal.stepRecords?.find((r) => r.stepId === step.stepId)?.completedAt
                          : null
                      }
                      displayNumber={steps.indexOf(step) + 1}
                      tabStop={step.id === tabStop}
                      handle={item?.handle}
                      buttonRef={(el) => {
                        if (el) stepRefs.current.set(step.id, el);
                        else stepRefs.current.delete(step.id);
                      }}
                      onOpen={() => onOpenStep(step.id, stepRefs.current.get(step.id) ?? null)}
                      onFocus={() =>
                        setLastFocused((prev) =>
                          prev[summary.phase.index] === step.id
                            ? prev
                            : { ...prev, [summary.phase.index]: step.id },
                        )
                      }
                      onKeyDown={onStepKeyDown(column, row)}
                      highlight={step.id === highlightStepId}
                      footer={stepFooter?.(step)}
                    />
                    {onAddStepAfter && row < visible.stepIds.length - 1 ? (
                      <StepGapAdd
                        label={`Add a step after ${stepTitle(step)}`}
                        tabIndex={step.id === tabStop ? 0 : -1}
                        onAdd={() => onAddStepAfter(step)}
                      />
                    ) : null}
                  </>
                );
                // Folded under the column's "N done" row: no card until unfolded.
                if (foldIds.has(step.id)) {
                  const lastPrior = foldablePrior[foldablePrior.length - 1];
                  return (
                    <React.Fragment key={step.id}>
                      {/* The run's own row sits where its steps sit in the rail. */}
                      {step.id === foldablePrior[0]?.id ? (
                        <li className={ROW_CLASS}>
                          <FoldToggle
                            label={`${foldablePrior.length} before Conductia`}
                            mark={<PriorFoldMark />}
                            open={priorOpen}
                            onToggle={() => onTogglePriorFold?.(summary.phase.index)}
                            controls={`rail-phase-${summary.phase.index}-steps`}
                          />
                          {onAddStepAfter && !priorOpen ? (
                            <StepGapAdd
                              label="Add a step after the steps before Conductia"
                              tabIndex={0}
                              onAdd={() => onAddStepAfter(lastPrior)}
                            />
                          ) : null}
                        </li>
                      ) : null}
                      <AnimatePresence initial={false}>
                        {hidden.has(step.id) ? null : (
                          <FoldRow key="row" item={item}>
                            {body}
                          </FoldRow>
                        )}
                      </AnimatePresence>
                    </React.Fragment>
                  );
                }
                return (
                  // The dashed track between one card and the next.
                  <li key={step.id} ref={item?.ref} style={item?.style} className={ROW_CLASS}>
                    {body}
                  </li>
                );
              };
              return (
                <PhaseColumn
                  key={summary.phase.index}
                  summary={summary}
                  expanded={expanded.has(summary.phase.index)}
                  onToggle={() => onTogglePhase(summary.phase.index)}
                  buttonRef={(el) => {
                    if (el) phaseRefs.current.set(summary.phase.index, el);
                    else phaseRefs.current.delete(summary.phase.index);
                  }}
                  onKeyDown={onPhaseKeyDown(column)}
                  fold={
                    foldable.length > 0
                      ? {
                          count: foldable.length,
                          open: doneOpen,
                          onToggle: () => onToggleFold?.(summary.phase.index),
                          // Under a closed row the next card follows the run's last step.
                          onAddAfter:
                            onAddStepAfter && !doneOpen
                              ? () => onAddStepAfter(foldable[foldable.length - 1])
                              : undefined,
                        }
                      : null
                  }
                  footer={columnFooter?.(summary)}
                  headerExtra={phaseHeaderExtra?.(summary)}
                >
                  {renderStack
                    ? renderStack(summary, renderCard, visible.shown)
                    : visible.shown.map((step) => renderCard(step))}
                </PhaseColumn>
              );
            })}
          </ol>
          <RailTerminal end="end" />
          {overlay}
        </div>
      </div>
    </section>
  );
}

/** One end of the rail: where the deal starts and where it closes. */
function RailTerminal({ end }: { end: 'start' | 'end' }) {
  return (
    <div
      data-terminal={end}
      title={end === 'start' ? 'Start' : 'End'}
      className="relative z-[1] flex items-center gap-[var(--space-2)] md:shrink-0 md:flex-col"
    >
      <span
        aria-hidden
        className="flex size-6 items-center justify-center rounded-full bg-[var(--ink-secondary)] shadow-[0_0_0_2px_rgb(0_0_0/0.14)]"
      >
        {end === 'start' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt="" src="/rail/rail-start.svg" className="block size-4" />
        ) : (
          <LandPlot size={12} strokeWidth={1} className="text-[var(--ink-on-dark)]" />
        )}
      </span>
      <span className="text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)] md:sr-only">
        {end === 'start' ? 'Start' : 'End'}
      </span>
    </div>
  );
}

export default RailBoard;
