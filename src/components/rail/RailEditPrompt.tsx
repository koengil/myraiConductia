'use client';

import * as React from 'react';
import Link from 'next/link';

import { Button } from '@/components/atoms/Button';
import { Dialog, PreviewChip, useRetainedWhileClosing } from '@/components/overlay';
import { settingsHref } from '@/lib/settings/href';

/** What the person just changed on the rail. */
export type RailEdit =
  | { kind: 'added'; title: string | null }
  | { kind: 'removed'; title: string }
  | { kind: 'moved'; title: string };

export const RAIL_EDIT_PROMPT_COPY = {
  scope: 'This changes the rail for everyone on this deal.',
  apply: 'Apply to this deal',
  saveAsCompany: 'Apply and save as a company rail…',
  dontAsk: "Don't ask again",
  /** A move is a Preview (handoff E1): it never reaches the deal, so it never claims to. */
  movedScope: 'Only you see this order. It is kept in this browser and is not saved to the deal.',
  keep: 'Keep in this browser',
  reset: 'Reset',
} as const;

/** "You can change this in Settings › Rails", or the truth when storage refused the choice. */
export const DONT_ASK_NOT_KEPT = 'This browser is not keeping settings, so Conductia will ask again.';

function titleFor(edit: RailEdit): string {
  if (edit.kind === 'added') return edit.title ? `${edit.title} added` : 'Step added';
  if (edit.kind === 'removed') return `${edit.title} removed`;
  return `${edit.title} moved`;
}

/**
 * The prompt after someone with rail editing rights adds, removes or moves a
 * step.
 *
 * Adds and removes are already saved by the time it shows, so it states the
 * multiplayer fact (there is no personal rail: a change reaches everyone on
 * the deal) and offers to save the rail for the company, never a second save.
 * Moves are a Preview (handoff E1 "Save a step reorder (deal rail and rail
 * templates)", docs/03-engineering/walkthrough-handoff-2026-10-22.md): the new
 * order stays in this browser, so the prompt says so and offers Keep in this
 * browser or Reset, never "Apply", which would read as saved.
 */
export function RailEditPrompt({
  edit,
  canSaveRail,
  onApply,
  onReset,
  onSaveAsCompanyRail,
  onDontAskAgain,
}: {
  /** The change just made; null closes the prompt. */
  edit: RailEdit | null;
  canSaveRail: boolean;
  /** Closes the prompt (for a move: keeps the Preview order). */
  onApply: () => void;
  /** A move only: restores the saved order and closes the prompt. */
  onReset: () => void;
  onSaveAsCompanyRail: () => void;
  /** `viaKeyboard`: the button was pressed from the keyboard, so the confirmation takes focus. */
  onDontAskAgain: (options: { viaKeyboard: boolean }) => void;
}) {
  const shown = useRetainedWhileClosing(edit);
  const moved = shown?.kind === 'moved';
  // Focus lands on the default, never on "Don't ask again".
  const applyRef = React.useRef<HTMLButtonElement | null>(null);
  return (
    <Dialog
      open={edit !== null}
      onClose={onApply}
      eyebrow="Rail change"
      title={shown ? titleFor(shown) : 'Rail change'}
      description={moved ? RAIL_EDIT_PROMPT_COPY.movedScope : RAIL_EDIT_PROMPT_COPY.scope}
      size="lg"
      initialFocus={applyRef}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-[var(--space-2)]">
          <Button
            variant="ghost"
            // A click from Enter or Space has no pointer press (detail 0).
            onClick={(event) => onDontAskAgain({ viaKeyboard: event.detail === 0 })}
          >
            {RAIL_EDIT_PROMPT_COPY.dontAsk}
          </Button>
          {moved ? (
            <div className="flex flex-wrap items-center justify-end gap-[var(--space-2)]">
              <Button variant="secondary" onClick={onReset}>
                {RAIL_EDIT_PROMPT_COPY.reset}
              </Button>
              <Button ref={applyRef} onClick={onApply}>
                {RAIL_EDIT_PROMPT_COPY.keep}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-[var(--space-2)]">
              <Button variant="secondary" onClick={onSaveAsCompanyRail} disabled={!canSaveRail}>
                {RAIL_EDIT_PROMPT_COPY.saveAsCompany}
              </Button>
              <Button ref={applyRef} onClick={onApply}>
                {RAIL_EDIT_PROMPT_COPY.apply}
              </Button>
            </div>
          )}
        </div>
      }
    >
      {moved ? (
        <p className="flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {/* Preview: handoff E1 "Save a step reorder (deal rail and rail templates)". */}
          <PreviewChip />
          <span>Reset or a reload shows the deal&apos;s saved order again.</span>
        </p>
      ) : (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          The change is on this deal&apos;s rail now. Save the rail for your company and new deals
          can start from it.
        </p>
      )}
      {canSaveRail || moved ? null : (
        <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          Saving a company rail is not available on this deal.
        </p>
      )}
    </Dialog>
  );
}

/** How long the "Don't ask again" confirmation stays on screen. */
export const DONT_ASK_CONFIRM_MS = 2000;

/**
 * "You can change this in Settings › Rails", shown for about two seconds after
 * "Don't ask again". The live region stays mounted so the message is
 * announced when it fills. It stays while the pointer or focus is on it; when
 * "Don't ask again" was pressed from the keyboard, focus moves to the Settings
 * link so it can be reached, and Escape hands focus back. When this browser
 * refused to store the choice (`notKept`), it says Conductia will ask again
 * instead, with no link.
 */
export function DontAskAgainConfirmation({
  shownAt,
  focusLink = false,
  notKept = false,
  onDone,
}: {
  shownAt: number | null;
  focusLink?: boolean;
  notKept?: boolean;
  onDone: () => void;
}) {
  const [held, setHeld] = React.useState(false);
  const linkRef = React.useRef<HTMLAnchorElement | null>(null);
  const returnTo = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (shownAt === null || held) return;
    const timer = window.setTimeout(onDone, DONT_ASK_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [shownAt, held, onDone]);
  React.useEffect(() => {
    if (shownAt === null || !focusLink) return;
    // After the prompt has handed focus back, so the link keeps it.
    const frame = window.requestAnimationFrame(() => {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      linkRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shownAt, focusLink]);
  const shown = shownAt !== null;
  const done = () => {
    setHeld(false);
    onDone();
    if (returnTo.current?.isConnected) returnTo.current.focus();
    returnTo.current = null;
  };
  return (
    <div
      role="status"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') done();
      }}
      className={
        shown
          ? 'fixed bottom-[var(--space-5)] left-1/2 z-[90] -translate-x-1/2 rounded-[var(--radius-control)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-on-dark)] shadow-[var(--elev-2)]'
          : 'sr-only'
      }
    >
      {shown && notKept ? (
        DONT_ASK_NOT_KEPT
      ) : shown ? (
        <>
          You can change this in{' '}
          <Link ref={linkRef} href={settingsHref('rails')} className="font-medium underline underline-offset-2">
            Settings › Rails
          </Link>
          .
        </>
      ) : null}
    </div>
  );
}

export default RailEditPrompt;
