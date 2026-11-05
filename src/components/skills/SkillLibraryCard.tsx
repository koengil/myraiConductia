'use client';

import * as React from 'react';

import type { RailStep } from '@/lib/rail/dealRail';
import { Badge } from '@/components/atoms';
import {
  approvalStateForStep,
  APPROVAL_STATE_LABEL,
  APPROVAL_STATE_TONE,
  OWNER_CHIP_LABEL,
} from './governance';

/**
 * SkillLibraryCard — one governed step-skill in the library grid.
 *
 * Card grammar per the the reference UI digest (steal #8), adapted to tokens: icon tile
 * (the canonical seq numeral doubles as the icon — provenance over
 * decoration), bold name, a one-line "why it's better" value proposition
 * (WS6: value, not mechanism — the execution-class code and the io contract are
 * withheld from the banker surface), owner + ★ attribution, and the
 * approval-state chip that REPLACES any self-serve enable toggle. Cards sit in
 * a hairline-separated 2-column grid (the parent owns the hairlines); the whole
 * card is the detail affordance.
 *
 * Contrast: LIGHT working surface — dark ink tokens only. Single-accent
 * discipline (navy): the accent tokens mark exactly the ★ priority glyph and
 * the Active state chip; everything else is neutral ink and hairlines.
 */
export function SkillLibraryCard({
  step,
  onOpen,
}: {
  step: RailStep;
  onOpen: (step: RailStep) => void;
}) {
  const state = approvalStateForStep(step);

  return (
    <button
      type="button"
      onClick={() => onOpen(step)}
      aria-label={`${step.title} step skill`}
      aria-haspopup="dialog"
      data-step-id={step.id}
      data-approval-state={state}
      data-priority={step.priorityBuild ? 'true' : 'false'}
      className={
        'flex w-full items-start gap-[var(--space-4)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-5)] text-left ' +
        'transition-colors duration-150 ease-out ' +
        'hover:bg-[var(--surface-raised)] focus-visible:outline-none ' +
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]'
      }
    >
      {/* Icon tile — the canonical sequence numeral. */}
      <span
        aria-hidden="true"
        className={
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-input)] ' +
          'bg-[var(--surface-subtle)] font-mono text-[length:var(--text-xs)] font-medium ' +
          'text-[var(--ink-secondary)] ring-1 ring-inset ring-[var(--stroke)] tnum'
        }
      >
        {String(step.seq).padStart(2, '0')}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-[var(--space-2)]">
        <span className="flex items-baseline gap-[var(--space-2)]">
          <span className="min-w-0 truncate font-sans text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
            {step.title}
          </span>
          {step.priorityBuild ? (
            <>
              <span aria-hidden="true" className="text-[var(--accent-dark)]">
                ★
              </span>
              <span className="sr-only">Priority build.</span>
            </>
          ) : null}
        </span>

        <span className="line-clamp-2 font-sans text-[length:var(--text-sm)] leading-snug text-[var(--ink-secondary)]">
          {step.whyBetter ?? step.description}
        </span>

        <span className="flex flex-wrap items-center gap-[var(--space-2)] pt-[var(--space-1)]">
          <Badge tone="neutral">{OWNER_CHIP_LABEL[step.buildOwner]}</Badge>
          <Badge tone={APPROVAL_STATE_TONE[state]}>
            {APPROVAL_STATE_LABEL[state]}
          </Badge>
        </span>
      </span>
    </button>
  );
}

export default SkillLibraryCard;
