'use client';

import * as React from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

import { OVERLAY_EASE } from '@/components/overlay/motion';
import { logAudit } from '@/lib/audit/store';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { DEAL_RAIL, MVP_DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import { drawsOnFor } from '@/lib/rail/drawsOn';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import { AssignStepControls } from './AssignStepControls';
import { CustomStepPanel } from './CustomStepPanel';
import { DrawsOn } from './DrawsOn';
import { shortPhaseName, type BoardPhase } from './railBoardModel';
import type { RailRunState } from './railRunState';
import { isEditable, useZoomOutGestures } from './RailZoom';
import { RemoveStepControl } from './RemoveStepControl';
import { StepContract, stepPanelAssigns } from './StepContract';
import { StepMarker } from './StepCard';
import { stepStateForStep, type StepState } from './stepState';

/** A cited step's catalog name, for one no longer on this deal's rail. */
function catalogTitle(seq: number): string | undefined {
  return orderedSteps(DEAL_RAIL).find((s) => s.seq === seq)?.title;
}

/** Which way the MD walked: the step slides in from that side. */
export type WalkDirection = -1 | 0 | 1;

/** A step's slide when the MD walks to a neighbour: a short travel, then still. */
const WALK_PX = 24;

function StepSlide({
  ref,
  direction,
  children,
}: {
  /** AnimatePresence popLayout measures the outgoing step through this ref. */
  ref?: React.Ref<HTMLDivElement>;
  direction: WalkDirection;
  children: React.ReactNode;
}) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      ref={ref}
      custom={direction}
      variants={{
        enter: (d: WalkDirection) => ({ opacity: 0, x: d * WALK_PX }),
        center: { opacity: 1, x: 0 },
        exit: (d: WalkDirection) => ({ opacity: 0, x: d * -WALK_PX }),
      }}
      initial="enter"
      animate="center"
      exit="exit"
      transition={{ duration: 0.18, ease: OVERLAY_EASE }}
      aria-hidden={isPresent ? undefined : true}
      inert={!isPresent}
    >
      {children}
    </motion.div>
  );
}

/**
 * StepZoom: one step, the body of the dialog that opens over the board. The
 * step's full contract scrolls above the step before and the step after, which
 * stay in view, so the MD always knows where the step sits and can walk on.
 * Closing (the button, Escape, ctrl-wheel or a pinch) returns to the board with
 * this step's phase open.
 */
export function StepZoom({
  steps,
  phases,
  viewIndex,
  direction = 0,
  run,
  dealId,
  onComplete,
  onSkip,
  onJump,
  onZoomOut,
  stateFor = (s) => stepStateForStep(s),
  takeFocus = false,
  canRemove,
  onRemoved,
  showOwner = false,
  onAssigned,
  moveAction,
  onEnhance,
  canTeach,
  builderChanges,
}: {
  steps: readonly ProjectRailStep[];
  phases: readonly BoardPhase[];
  /** Which step is zoomed in. */
  viewIndex: number;
  direction?: WalkDirection;
  run: RailRunState;
  dealId: string;
  onComplete: (options?: { recorded?: boolean; stepId?: string; currentStepId?: string | null }) => void;
  onSkip: (step: ProjectRailStep) => void;
  onJump: (index: number) => void;
  onZoomOut: () => void;
  /** A step's state as the board reads it (intake overlay included), for the neighbours. */
  stateFor?: (step: ProjectRailStep) => StepState;
  /** Move keyboard focus here on arrival (the MD zoomed in themselves). */
  takeFocus?: boolean;
  canRemove?: boolean;
  onRemoved?: () => void;
  /** A real deal: open steps whose panel has no owner line show one here. */
  showOwner?: boolean;
  /** After any assignment in this detail: the board's owner read refreshes. */
  onAssigned?: () => void;
  /** What Move to… does for a step, or null where the step cannot move. */
  moveAction?: (step: ProjectRailStep) => (() => void) | null;
  onEnhance?: (basisStepId: string, seedRunId: string | null, teach?: boolean) => void;
  canTeach?: boolean;
  builderChanges?: number;
}) {
  const reduce = useReducedMotion();
  const deal = useActiveDeal(dealId);
  const step = steps[viewIndex];
  const [section, sectionRef] = React.useState<HTMLElement | null>(null);
  useZoomOutGestures(section, true, onZoomOut);

  // The MD opened it themselves: keyboard focus lands on the step.
  React.useEffect(() => {
    if (section && takeFocus) section.focus({ preventScroll: true });
  }, [takeFocus, section]);

  const phase = step ? phases.find((p) => p.index === step.phaseIndex) : undefined;
  const phaseName = phase ? shortPhaseName(phase.name) : 'the rail';

  const closeBar = (
    <div className="mb-[var(--space-1)] flex justify-end">
      <button
        type="button"
        onClick={onZoomOut}
        aria-label={`Zoom out to ${phaseName}`}
        aria-keyshortcuts="Escape"
        title="Close (Esc)"
        className="inline-flex size-8 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
      >
        <X aria-hidden size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
  // Escape in a text field clears or leaves the field, never the whole step.
  const keepEscapeInField = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && isEditable(e.target)) e.preventDefault();
  };

  if (!step) {
    return (
      <section ref={sectionRef} aria-label="Step detail" tabIndex={-1} className="outline-none">
        {closeBar}
        <div className="rounded-[var(--radius-card)] border border-transparent bg-[var(--positive-fill)] p-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--positive-deep)]">
          Every step on the rail is complete. The record is frozen and the audit trail is
          retained.
        </div>
      </section>
    );
  }

  const state: StepState = stateFor(step);
  const prev = viewIndex > 0 ? steps[viewIndex - 1] : undefined;
  const next = viewIndex < steps.length - 1 ? steps[viewIndex + 1] : undefined;
  // Compliance record: completing or advancing the active step is a material
  // action. The bare advance only moves the cursor (handoff E28), so its row
  // says that, never "Marked complete".
  function handleComplete(options?: { recorded?: boolean; currentStepId?: string | null }) {
    logAudit('step', options?.recorded ? 'Marked complete' : 'Moved to the next step', stepTitle(step), {
      deal: deal.codename,
    });
    onComplete({ ...options, stepId: step.id });
  }

  const catalogStep = step.catalog;
  const catalogPhase = catalogStep ? phaseForStep(catalogStep.id, MVP_DEAL_RAIL) : undefined;
  const drawsOn = drawsOnFor(step, steps, stepTitle, catalogTitle);
  const enhanceStep = onEnhance
    ? (seedRunId: string | null, teach?: boolean) => onEnhance(step.stepId, seedRunId, teach)
    : undefined;

  const assignHere =
    showOwner &&
    (state === 'active' || state === 'todo') &&
    !(catalogStep && stepPanelAssigns(catalogStep));
  const move = moveAction?.(step) ?? null;
  const removeHere = Boolean(onRemoved && canRemove);

  const detail = (
    <div className="px-[var(--space-2)]">
      {catalogStep && catalogPhase ? (
        <StepContract
          // One contract per step: per-step state (an open runner) never
          // carries over when the zoom moves to another step.
          key={step.id}
          step={catalogStep}
          projectStep={step}
          phase={catalogPhase}
          state={state}
          dealId={dealId}
          receipts={run.receipts[step.stepId] ?? []}
          skip={step.skip ?? undefined}
          versions={run.versions[step.stepId] ?? []}
          onComplete={handleComplete}
          onSkip={() => onSkip(step)}
          onEnhance={enhanceStep}
          canTeach={canTeach}
          builderChanges={builderChanges}
          stepNumber={viewIndex + 1}
          onAssigned={onAssigned}
        />
      ) : (
        <CustomStepPanel
          step={step}
          state={state}
          dealId={dealId}
          onComplete={handleComplete}
          onEnhance={enhanceStep}
          canTeach={canTeach}
          builderChanges={builderChanges}
          stepNumber={viewIndex + 1}
          phaseName={phase ? phaseName : undefined}
        />
      )}
      <DrawsOn
        refs={drawsOn}
        stateFor={stateFor}
        onOpen={(target) => {
          const index = steps.indexOf(target);
          if (index >= 0) onJump(index);
        }}
      />
      {assignHere || move || removeHere ? (
        <div className="mt-[var(--space-4)] flex flex-col gap-[var(--space-3)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
          {assignHere ? (
            <AssignStepControls
              key={step.id}
              dealId={dealId}
              stepId={step.stepId}
              stepTitle={stepTitle(step)}
              onAssigned={onAssigned}
            />
          ) : null}
          {move || removeHere ? (
            <div className="flex flex-wrap items-start gap-[var(--space-2)]">
              {move ? (
                <button
                  type="button"
                  onClick={move}
                  className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-2)] py-1 text-[length:var(--text-xxs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
                >
                  Move to…
                </button>
              ) : null}
              {onRemoved && canRemove ? (
                <RemoveStepControl
                  projectId={dealId}
                  step={step}
                  canRemove={canRemove}
                  onRemoved={onRemoved}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <section
      ref={sectionRef}
      aria-label="Step detail"
      tabIndex={-1}
      onKeyDown={keepEscapeInField}
      className="outline-none"
    >
      {closeBar}
      {reduce ? (
        detail
      ) : (
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
          <StepSlide key={step.id} direction={direction}>
            {detail}
          </StepSlide>
        </AnimatePresence>
      )}
      {/* Stays in view while a long contract scrolls behind it. */}
      <div className="sticky bottom-0 mt-[var(--space-4)] grid grid-cols-2 gap-[var(--space-3)] bg-[var(--surface)] pt-[var(--space-3)]">
        <nav aria-label="Previous step">
          <NeighbourStep
            label="Previous step"
            step={prev}
            phases={phases}
            currentPhaseIndex={step.phaseIndex}
            direction="prev"
            stateFor={stateFor}
            onClick={() => prev && onJump(viewIndex - 1)}
          />
        </nav>
        <nav aria-label="Next step">
          <NeighbourStep
            label="Next step"
            step={next}
            phases={phases}
            currentPhaseIndex={step.phaseIndex}
            direction="next"
            stateFor={stateFor}
            onClick={() => next && onJump(viewIndex + 1)}
          />
        </nav>
      </div>
    </section>
  );
}

/** The step either side of the zoomed one, or the rail's end when there is none. */
function NeighbourStep({
  label,
  step,
  phases,
  currentPhaseIndex,
  direction,
  stateFor,
  onClick,
}: {
  label: string;
  step?: ProjectRailStep;
  phases: readonly BoardPhase[];
  currentPhaseIndex: number;
  direction: 'prev' | 'next';
  stateFor: (step: ProjectRailStep) => StepState;
  onClick: () => void;
}) {
  const alignEnd = direction === 'next' ? 'text-right items-end' : 'items-start';
  if (!step) {
    return (
      <div
        data-terminal={direction === 'prev' ? 'start' : 'end'}
        className={`flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-dashed border-[var(--stroke-strong)] p-[var(--space-3)] ${alignEnd}`}
      >
        <span className="block size-3.5 rounded-full border-2 border-[var(--ink)] bg-[var(--surface-warm)]" />
        <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {direction === 'prev' ? 'Start of the rail' : 'End of the rail'}
        </span>
      </div>
    );
  }
  const state = stateFor(step);
  const otherPhase =
    step.phaseIndex !== currentPhaseIndex
      ? phases.find((p) => p.index === step.phaseIndex)
      : undefined;
  const Arrow = direction === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label} · ${stepTitle(step)}`}
      className={`flex w-full flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)] text-left transition-[border-color,box-shadow] duration-150 hover:border-[var(--stroke-strong)] hover:shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${alignEnd}`}
    >
      <span
        className={`flex items-center gap-[var(--space-1)] text-[length:var(--text-xxs)] font-medium text-[var(--ink-tertiary)] ${direction === 'next' ? 'flex-row-reverse' : ''}`}
      >
        <Arrow aria-hidden size={12} strokeWidth={2} />
        {direction === 'prev' ? 'Previous' : 'Next'}
      </span>
      <span className={`flex w-full items-start gap-[var(--space-2)] ${direction === 'next' ? 'flex-row-reverse' : ''}`}>
        <span className="mt-0.5">
          <StepMarker state={state} />
        </span>
        <span className="line-clamp-3 min-w-0 text-[length:var(--text-sm)] font-medium leading-snug text-[var(--ink)]">
          {stepTitle(step)}
        </span>
      </span>
      {otherPhase ? (
        <span className="text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
          In {shortPhaseName(otherPhase.name)}
        </span>
      ) : null}
    </button>
  );
}

export default StepZoom;
