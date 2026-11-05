'use client';

import { Button } from '@/components/atoms/Button';

const BANNER_DETAIL = 'Only you see this. Nothing here is saved to the deal.';

/**
 * The honest-preview copy, verbatim. A Preview is a prototype that runs in
 * this browser only and saves nothing; it carries one of these markers and a
 * code comment linking its engineer handoff entry.
 */
export const PREVIEW_COPY = {
  chip: 'Preview',
  description: 'Not saved yet. Engineers are wiring this.',
  /** The full banner sentence, as it reads on screen. */
  banner: `Preview. ${BANNER_DETAIL}`,
  reset: 'Reset',
} as const;

export type PreviewChipProps = {
  className?: string;
};

/**
 * The inline "Preview" marker for a control or section that is not saved
 * yet. Dashed field-gray pill; the description shows on hover and is read
 * to screen readers. Use the same chip everywhere a Preview exists.
 */
export function PreviewChip({ className }: PreviewChipProps) {
  return (
    <span
      data-preview="chip"
      title={PREVIEW_COPY.description}
      className={[
        'inline-flex items-center rounded-full border border-dashed border-[var(--stroke-strong)] bg-[var(--surface-subtle)] px-[var(--space-2)] py-[2px] font-sans text-[length:var(--text-xs)] font-medium leading-none text-[var(--ink-secondary)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span>{PREVIEW_COPY.chip}</span>
      <span className="sr-only"> {PREVIEW_COPY.description}</span>
    </span>
  );
}

export type PreviewBannerProps = {
  /**
   * What stays unsaved, in a sentence, when the deal wording does not fit
   * (a template, for example). Defaults to the deal sentence.
   */
  message?: string;
  /** Shows a Reset action that puts the preview back to its starting state. */
  onReset?: () => void;
  className?: string;
};

/**
 * The page- or panel-level Preview marker: "Preview. Only you see this.
 * Nothing here is saved to the deal." with an optional Reset. Sits at the
 * top of the surface it covers; inside it, individual controls need no chip.
 */
export function PreviewBanner({ onReset, message = BANNER_DETAIL, className }: PreviewBannerProps) {
  return (
    <div
      data-preview="banner"
      className={[
        'flex flex-wrap items-center gap-[var(--space-3)] rounded-[var(--radius-control)] border border-dashed border-[var(--stroke-strong)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <p className="min-w-0 flex-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        <strong className="font-semibold text-[var(--ink)]">{PREVIEW_COPY.chip}.</strong> {message}
      </p>
      {onReset ? (
        <Button variant="ghost" size="sm" onClick={onReset}>
          {PREVIEW_COPY.reset}
        </Button>
      ) : null}
    </div>
  );
}
