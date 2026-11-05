'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { Dialog, PreviewChip, useRetainedWhileClosing } from '@/components/overlay';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';

export type MoveTarget = {
  step: ProjectRailStep;
  phaseName: string;
  /** The phase's steps in the order shown now (the Preview order when there is one). */
  phaseSteps: readonly ProjectRailStep[];
  /** Rail number of a step (its saved position), for the option labels. */
  numberOf: (step: ProjectRailStep) => string;
  /** The positions a saved move would allow (never ahead of a step that cannot move); all when absent. */
  allowed?: ReadonlySet<number>;
  /** Replaces the line under the title (where a step may go). Rails configuration names its own rule. */
  description?: string;
  /** Replaces the Preview line (what is and is not saved). */
  previewNote?: string;
};

/** Why Move step is not available: the chosen position is where the step is now. */
export const SAME_PLACE_COPY = 'This is already its place.';

/**
 * "Move to…", the keyboard and screen-reader path for reordering a step (and
 * the one that names every position). Pointer drag on the board does the same
 * move. Both change the order in this browser only: a Preview until moves are
 * saved (handoff E1, docs/03-engineering/walkthrough-handoff-2026-10-22.md).
 */
export function MoveStepDialog({
  target,
  onClose,
  onMove,
}: {
  /** The step to move; null closes the dialog. */
  target: MoveTarget | null;
  onClose: () => void;
  /** The index the step should take in `phaseSteps`. */
  onMove: (step: ProjectRailStep, toIndex: number) => void;
}) {
  const shown = useRetainedWhileClosing(target);
  const samePlaceId = React.useId();
  const [choice, setChoice] = React.useState<{ id: string; index: number } | null>(null);
  const from = shown ? shown.phaseSteps.findIndex((s) => s.id === shown.step.id) : -1;
  const others = shown ? shown.phaseSteps.filter((s) => s.id !== shown.step.id) : [];
  // Position k = "after the k-th other step" (0 = first in the phase). The
  // step sits at position `from` today.
  const chosen = choice && shown && choice.id === shown.step.id ? choice.index : from;
  const close = () => {
    setChoice(null);
    onClose();
  };
  const confirm = () => {
    if (!shown || chosen === from || chosen < 0) return;
    onMove(shown.step, chosen);
    setChoice(null);
  };
  const options = shown
    ? [
        { index: 0, label: `First in ${shown.phaseName}` },
        ...others.map((s, i) => ({ index: i + 1, label: `After ${shown.numberOf(s)} · ${stepTitle(s)}` })),
      ].filter((option) => !shown.allowed || shown.allowed.has(option.index))
    : [];

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      eyebrow="Move step"
      title={shown ? stepTitle(shown.step) : 'Move step'}
      description={
        shown
          ? (shown.description ??
            `Choose where it sits in ${shown.phaseName}. Steps move within their phase, after any step that is done or required.`)
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={!shown || chosen === from}
            aria-describedby={shown && chosen === from ? samePlaceId : undefined}
            onClick={confirm}
          >
            Move step
          </Button>
        </>
      }
    >
      <p className="mb-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {/* Preview: handoff E1 "Save a step reorder (deal rail and rail templates)". */}
        <PreviewChip />
        <span>{shown?.previewNote ?? 'The new order shows in this browser only. Nothing is saved to the deal.'}</span>
      </p>
      <fieldset className="flex max-h-[min(420px,50vh)] flex-col gap-[var(--space-1)] overflow-y-auto border-0 p-0.5">
        <legend className="bank-label mb-[var(--space-2)]">Position</legend>
        {options.map((option) => (
          <label
            key={option.index}
            className="flex min-h-10 items-center gap-[var(--space-3)] rounded-[var(--radius-control)] px-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] hover:bg-[var(--surface-raised)]"
          >
            <input
              type="radio"
              name="move-step-position"
              value={option.index}
              checked={chosen === option.index}
              onChange={() => shown && setChoice({ id: shown.step.id, index: option.index })}
              className="h-4 w-4 shrink-0 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.index === from ? (
              <span className="shrink-0 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">Here now</span>
            ) : null}
          </label>
        ))}
      </fieldset>
      {shown && chosen === from ? (
        <p id={samePlaceId} className="mt-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {SAME_PLACE_COPY}
        </p>
      ) : null}
    </Dialog>
  );
}

export default MoveStepDialog;
