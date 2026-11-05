'use client';

import * as React from 'react';
import { Bot, Check, GripVertical, Users } from 'lucide-react';

import type { SortableHandle } from '@/lib/rail/boardContract';
import { skillBindingForStep, stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import { formatRelative } from '@/lib/format/date';
import { MANUAL_STEP_IDS } from '@/lib/rail/manualStepDefs';
import { skipApproverLabel } from '@/lib/rail/skipApproverLabel';
import { ON_RECORD } from '@/lib/rail/stepRecords';
import { RECEIPT_VERDICT_LABEL, type StepReceipt } from './railRunState';
import { STEP_STATE_CHIP, STEP_STATE_LABEL, stepStateForStep, type StepState } from './stepState';

const RECEIPT_TONE: Record<StepReceipt['verdict'], string> = {
  clear: 'var(--positive)',
  hold: 'var(--hold)',
  blocked: 'var(--negative)',
};

/** Deep text tones: AA at receipt sizes on white and warm surfaces. */
const RECEIPT_TEXT_TONE: Record<StepReceipt['verdict'], string> = {
  clear: 'var(--positive-deep)',
  hold: 'var(--hold-deep)',
  blocked: 'var(--negative-deep)',
};

/**
 * The collapsed run receipt on a step card: "Screened · 12s ›", expandable to
 * the check lines. A log line, not a live compliance instrument: the one
 * ribbon in the shell carries the live verdict.
 */
export function ReceiptLine({ receipt, tabIndex }: { receipt: StepReceipt; tabIndex?: number }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-t border-[var(--stroke)] pt-[var(--space-2)]">
      <button
        type="button"
        aria-expanded={open}
        tabIndex={tabIndex}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex w-full items-center gap-1.5 text-left font-mono text-[length:var(--text-xxs)] text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink)]"
      >
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-full"
          style={{ background: RECEIPT_TONE[receipt.verdict] }}
        />
        <span>
          {receipt.label} · {receipt.seconds}s
        </span>
        <span aria-hidden className="ml-auto">
          {open ? '▾' : '›'}
        </span>
      </button>
      {open ? (
        <div className="mt-1 space-y-0.5 font-mono text-[length:var(--text-xxs)] text-[var(--ink-secondary)]">
          <p style={{ color: RECEIPT_TEXT_TONE[receipt.verdict] }}>
            {RECEIPT_VERDICT_LABEL[receipt.verdict]}
          </p>
          {receipt.checks.map((c, i) => (
            <p key={i}>{c}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The state mark of a step: color plus shape, never color alone. */
export function StepMarker({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--positive)] ring-2 ring-[var(--surface-warm)]">
        <Check aria-hidden className="size-2.5 text-[var(--ink-on-dark)]" strokeWidth={2.5} />
      </span>
    );
  }
  const shape: Record<Exclude<StepState, 'done'>, string> = {
    active: 'bg-[var(--accent)]',
    skipped: 'border-2 border-dashed border-[var(--ink-tertiary)] bg-[var(--surface)]',
    prior: 'bg-[var(--stroke-strong)]',
    todo: 'border-2 border-[var(--stroke)] bg-[var(--surface)]',
  };
  return (
    <span
      className={`block size-3.5 shrink-0 rounded-full ring-2 ring-[var(--surface-warm)] ${shape[state]}`}
    />
  );
}

/**
 * The station mark on the board's cards and phase headers: a green check when
 * done, a filled half when the deal is in it, a dashed ring while still to do.
 * Shape carries the state, never color alone.
 */
export function StationStatus({ state }: { state: StepState }) {
  if (state === 'done' || state === 'active') {
    return (
      <span aria-hidden className="relative block size-3.5 shrink-0">
        {/* The exported mark is 18px: a 2px halo around the 14px circle. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt=""
          src={state === 'done' ? '/rail/status-done.svg' : '/rail/status-current.svg'}
          className="absolute inset-[-14.29%] block size-[calc(100%+4px)] max-w-none"
        />
      </span>
    );
  }
  if (state === 'todo') {
    return (
      <span
        aria-hidden
        className="block size-3.5 shrink-0 rounded-full border border-dashed border-[var(--ink-quiet)]"
      />
    );
  }
  return <StepMarker state={state} />;
}

/** Whether an agent runs the step (a bound skill, or an agent-led catalog step).
 *  A step worked through its manual checklist is Manual, whatever its class. */
export function isAutoStep(step: ProjectRailStep): boolean {
  if (skillBindingForStep(step) !== null) return true;
  if (MANUAL_STEP_IDS.has(step.stepId) && !step.catalog?.live) return false;
  const execution = step.catalog?.executionClass;
  return execution === 'A' || execution === 'A+H';
}

/** Who closed a done or skipped step, or null when nobody should be named.
 *  A done step reads as activity does: "Done by Alex Chen · 2h ago". */
export function completedByLine(
  step: ProjectRailStep,
  state: StepState,
  completedBy: string | null | undefined,
  completedAt?: string | null,
  now: number = Date.now(),
): string | null {
  // Nobody completed a step that happened before the deal opened here.
  if (state === 'prior') return null;
  // A record with no named person: say so rather than "Done by On record".
  if (state === 'done' && completedBy === ON_RECORD) return 'Done · On record';
  if (state === 'done' && completedBy) {
    const when = completedAt ? formatRelative(completedAt, now) : '';
    return `Done by ${completedBy}${when ? ` · ${when}` : ''}`;
  }
  if (state === 'skipped' && completedBy) {
    return `Completed by: ${completedBy}`;
  }
  // An empty approver or reason drops its segment, so the line never reads "Completed by:  · ".
  const skip = step.skip;
  const skipLine = skip ? [skipApproverLabel(skip), skip.reason].filter(Boolean).join(' · ') : '';
  return skip && !completedBy && skipLine ? `Completed by: ${skipLine}` : null;
}

/** The card's border: a skipped step dashed, every other card quiet until hovered. */
function cardBorder(state: StepState): string {
  if (state === 'skipped') return 'border-dashed border-[var(--stroke-strong)] hover:border-[var(--ink-tertiary)]';
  return 'border-[var(--stroke)] hover:border-[var(--stroke-strong)] hover:shadow-[var(--elev-2)]';
}

/** The chip beside the number: only where the mark alone does not say it. */
const CARD_CHIP: Partial<Record<StepState, string>> = {
  active: 'rounded-[6px] bg-[var(--surface-subtle)] px-1.5 py-px text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]',
  skipped: STEP_STATE_CHIP.skipped,
};

/**
 * StepCard: one step in a phase's stack on the rail board. The card body is
 * the button that zooms into the step; the receipt is its own control beside
 * it, so no buttons nest. On the board only one card per column is a tab stop (`tabStop`); arrows reach the rest.
 */
export function StepCard({
  step,
  state,
  receipt,
  completedBy,
  completedAt,
  buttonRef,
  onOpen = () => {},
  onFocus,
  onKeyDown,
  displayNumber,
  tabStop = true,
  handle,
  footer,
  highlight = false,
}: {
  step: ProjectRailStep;
  state?: StepState;
  receipt?: StepReceipt;
  /** Who completed this step: shown on done and skipped steps. */
  completedBy?: string | null;
  /** When a done step was completed (its step record), for "Done by X · 2h ago". */
  completedAt?: string | null;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onOpen?: () => void;
  onFocus?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  displayNumber?: number;
  /** Whether this card is its column's one tab stop (roving tabindex). */
  tabStop?: boolean;
  /** A sortable list's drag handle: spread on the card's button. */
  handle?: SortableHandle;
  /** Lines under the title from the board's later layers (owner, activity). */
  footer?: React.ReactNode;
  /** The step just added: an accent ring until the page is left. */
  highlight?: boolean;
}) {
  const resolvedState = state ?? stepStateForStep(step);
  const shownNumber = String(displayNumber ?? step.displayOrder);
  const number = shownNumber.padStart(2, '0');
  const tabIndex = tabStop ? 0 : -1;
  const isPrior = resolvedState === 'prior';
  const muted = resolvedState === 'todo' || resolvedState === 'skipped';
  const closedBy = completedByLine(step, resolvedState, completedBy, completedAt);
  const auto = isAutoStep(step);
  const OwnerIcon = auto ? Bot : Users;
  const chip = CARD_CHIP[resolvedState];
  // Edit rail hands a card that can move its drag listeners; every other card has none.
  const movable = Boolean(handle?.listeners);
  const handleKeyDown = handle?.listeners?.onKeyDown as
    | ((e: React.KeyboardEvent<HTMLButtonElement>) => void)
    | undefined;
  return (
    <div
      data-step={step.stepId}
      data-state={resolvedState}
      data-status={step.status}
      data-testid={`step-${step.id}`}
      data-highlight={highlight ? 'new' : undefined}
      className={[
        'group/card relative flex flex-col gap-[var(--space-2)] border',
        // The card eases back to give up the width its grip shows in, so both stay inside the column.
        movable
          ? 'transition-[border-color,box-shadow,margin] duration-[380ms] ease-[cubic-bezier(0.4,0,0.2,1)] hover:mr-5 hover:shadow-[4px_0_2.15px_rgb(0_0_0/0.03)] motion-reduce:transition-none [@media(hover:none)]:mr-5'
          : 'transition-[border-color,box-shadow] duration-150',
        highlight ? 'ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface-warm)]' : '',
        isPrior
          ? 'rounded-[var(--radius-card)] bg-[var(--surface-raised)] p-[var(--space-4)]'
          : 'rounded-[var(--radius-card)] bg-[var(--surface-warm)] p-[var(--space-4)]',
        cardBorder(resolvedState),
      ].join(' ')}
    >
      <div className="flex items-start gap-[var(--space-1)]">
        <button
          type="button"
          {...handle?.attributes}
          {...handle?.listeners}
          ref={(el) => {
            buttonRef?.(el);
            handle?.setActivatorNodeRef?.(el);
          }}
          tabIndex={tabIndex}
          onClick={onOpen}
          onFocus={onFocus}
          onKeyDown={(e) => {
            // A sortable's keyboard listener runs first; the board's arrows
            // move focus only when the handle left the key alone.
            handleKeyDown?.(e);
            if (!e.defaultPrevented) onKeyDown?.(e);
          }}
          aria-label={`Step ${number} · ${stepTitle(step)} · ${STEP_STATE_LABEL[resolvedState]}`}
          aria-current={resolvedState === 'active' ? 'step' : undefined}
          title={isPrior ? STEP_STATE_LABEL.prior : undefined}
          className={[
            'flex min-w-0 flex-1 rounded-[var(--radius-input)] text-left outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)]',
            movable ? 'cursor-grab active:cursor-grabbing' : '',
            isPrior ? 'flex-col gap-[var(--space-2)]' : 'min-h-[90px] flex-col justify-between gap-[var(--space-3)]',
          ].join(' ')}
        >
          {isPrior ? (
            // Before the deal opened here: reference only, so no type, owner or actions.
            <>
              <span className="flex w-full items-center gap-[var(--space-1)]">
                <StepMarker state={resolvedState} />
                <span className="text-[length:var(--text-sm)] font-medium tabular-nums text-[var(--ink-secondary)]">
                  {shownNumber}
                </span>
                <span className={`ml-auto ${CARD_CHIP.active}`}>Before Conductia</span>
              </span>
              <span className="line-clamp-3 text-[length:var(--text-sm)] font-semibold leading-[16.5px] text-[var(--ink-secondary)]">
                {stepTitle(step)}
              </span>
            </>
          ) : (
            <>
              <span className="flex w-full items-center gap-[var(--space-1)]">
                <StationStatus state={resolvedState} />
                <span className="text-[length:var(--text-sm)] font-medium tabular-nums text-[var(--ink-secondary)]">
                  {shownNumber}
                </span>
                {chip ? (
                  <span className={`ml-auto ${chip}`}>{STEP_STATE_LABEL[resolvedState]}</span>
                ) : null}
              </span>
              <span className="flex w-full items-end gap-[5px]">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[length:var(--text-sm)] leading-[1.45] text-[var(--ink-tertiary)]">
                    {auto ? 'Auto' : 'Manual'}
                  </span>
                  <span
                    className={[
                      'line-clamp-3 text-[length:var(--text-sm)] font-semibold leading-[16.5px]',
                      muted ? 'text-[var(--ink-secondary)]' : 'text-[var(--ink)]',
                    ].join(' ')}
                  >
                    {stepTitle(step)}
                  </span>
                  {closedBy ? (
                    <span className="mt-1 text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
                      {closedBy}
                    </span>
                  ) : null}
                </span>
                <OwnerIcon
                  aria-hidden
                  size={16}
                  strokeWidth={1.17}
                  className="shrink-0 text-[var(--ink-quiet)]"
                />
              </span>
            </>
          )}
        </button>
      </div>
      {/* The grip behind the card, easing out as the card eases back to fill the
          width it gave up. Both animate layout on one curve and duration, so they
          stay in step and the grip never passes the column's edge. It drags like
          the card; where nothing can hover it stays out. */}
      {movable ? (
        <span
          aria-hidden
          data-card-grip=""
          {...handle?.listeners}
          className="pointer-events-none absolute -inset-y-px right-[5px] -z-10 flex w-10 cursor-grab select-none items-center justify-end rounded-[var(--radius-card)] bg-[#c0c0c0] text-[var(--ink-on-dark)] opacity-0 [transition:opacity_240ms_ease-out,right_380ms_cubic-bezier(0.4,0,0.2,1)] active:cursor-grabbing group-hover/card:pointer-events-auto group-hover/card:-right-[21px] group-hover/card:opacity-100 motion-reduce:transition-none [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:-right-[21px] [@media(hover:none)]:opacity-100"
        >
          <GripVertical size={20} strokeWidth={1.75} />
        </span>
      ) : null}
      {footer}
      {receipt ? <ReceiptLine receipt={receipt} tabIndex={tabIndex} /> : null}
    </div>
  );
}

export default StepCard;
