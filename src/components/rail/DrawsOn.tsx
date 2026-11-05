'use client';

import * as React from 'react';

import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import type { DrawsOnRef } from '@/lib/rail/drawsOn';
import { StepMarker } from './StepCard';
import { STEP_STATE_LABEL, type StepState } from './stepState';

/** Where a cited step stands: later on the rail, its state, or off this rail. */
function whereLabel(ref: DrawsOnRef, state: StepState | null): string {
  if (ref.later) return 'Later step';
  if (state) return STEP_STATE_LABEL[state];
  return 'Not on this rail';
}

/**
 * "Draws on" in the zoomed step: the steps this step's brief names as inputs,
 * each with where it stands on this deal. Source references, not gates: a
 * later one reads "Later step", and nothing here says the step must wait.
 * Each one on the rail is a way to walk there.
 */
export function DrawsOn({
  refs,
  stateFor,
  onOpen,
}: {
  refs: readonly DrawsOnRef[];
  stateFor: (step: ProjectRailStep) => StepState;
  onOpen: (step: ProjectRailStep) => void;
}) {
  // Two zoomed steps coexist while the zoom walks: each heading needs its own id.
  const headingId = React.useId();
  if (refs.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="mt-[var(--space-4)] border-t border-[var(--stroke)] pt-[var(--space-3)]"
    >
      <div className="mb-[var(--space-2)] flex flex-wrap items-baseline gap-x-[var(--space-2)]">
        <h3 id={headingId} className="bank-label">
          Draws on
        </h3>
        <span className="text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
          From the step brief
        </span>
      </div>
      <ul className="flex flex-col gap-[var(--space-1)]">
        {refs.map((ref) => {
          const state = ref.step ? stateFor(ref.step) : null;
          const where = whereLabel(ref, state);
          const body = (
            <>
              {state ? <StepMarker state={state} /> : <span className="block size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-[var(--ink)]">
                {ref.step ? stepTitle(ref.step) : ref.title}
              </span>
              <span className="shrink-0 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {where}
              </span>
            </>
          );
          return (
            <li key={ref.seq}>
              {ref.step ? (
                <button
                  type="button"
                  onClick={() => ref.step && onOpen(ref.step)}
                  aria-label={`${stepTitle(ref.step)} · ${where}`}
                  className="flex min-h-9 w-full items-center gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-2)] text-left transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                >
                  {body}
                </button>
              ) : (
                <div className="flex min-h-9 items-center gap-[var(--space-2)] px-[var(--space-2)]">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default DrawsOn;
