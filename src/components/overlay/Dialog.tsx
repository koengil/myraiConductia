'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent, usePresence, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';

import { focusableIn, useModalDialog } from '@/lib/ui/useModalDialog';
import { OverlayContainerContext } from './container';
import { overlayTransition, travel } from './motion';

/** Dialog widths. `md` is the confirm/create default; `xl` fits the skill builder. */
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

const WIDTH: Record<DialogSize, string> = {
  sm: 'max-w-[360px]',
  md: 'max-w-[440px]',
  lg: 'max-w-[640px]',
  xl: 'max-w-[880px]',
};

export type DialogProps = {
  /**
   * Whether the dialog is shown. Keep the Dialog mounted and toggle this, so
   * it can play its exit. When the body needs a record that clears on close,
   * hold it with `useRetainedWhileClosing`. A parent that mounts the Dialog
   * conditionally wraps that condition in `<AnimatePresence>` (with a `key`)
   * so the exit still plays.
   */
  open: boolean;
  /** Called on Escape, the close button, and (unless turned off) a scrim click. */
  onClose: () => void;
  /** The visible heading (an `h2`). It names the dialog: dialogs are named by their title. */
  title: React.ReactNode;
  /** Small line above the title, e.g. "Leaving Conductia" or "Skip step · logged". */
  eyebrow?: React.ReactNode;
  /** One line under the title. Wired to `aria-describedby`. */
  description?: React.ReactNode;
  /**
   * Escape hatch. Only when the visible title cannot name the dialog; new
   * dialogs never set it. Replaces `aria-labelledby` (the title) with
   * `aria-label`, so what a screen reader hears drifts from what is shown.
   */
  ariaLabel?: string;
  /** Panel width. Default `md` (440px). */
  size?: DialogSize;
  /** Actions row, right-aligned. Put the primary action last. */
  footer?: React.ReactNode;
  /**
   * Element to focus on open. Default: the first focusable control in the
   * body, then in the footer, then the close button.
   */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /**
   * Whether a click on the scrim closes the dialog. Default `true`. Turn it
   * off when the dialog holds typed input or a destructive step, so a stray
   * click cannot discard it. Escape and the close button always close.
   */
  dismissOnScrim?: boolean;
  /**
   * No title row and no close button: the body brings its own heading and
   * close control, and `ariaLabel` names the dialog. For a body that is a whole
   * surface (the rail step detail), never a confirm or a form.
   */
  headless?: boolean;
  /** The dialog body. Scrolls when the panel would outgrow the viewport. */
  children?: React.ReactNode;
};

const noopSubscribe = () => () => {};

/** False during SSR and hydration, true once `document.body` can take a portal. */
function useCanPortal() {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * Holds the last non-empty `value`, so a Dialog body can keep showing its
 * record while the exit plays after the parent clears it.
 *
 * @example
 * const shown = useRetainedWhileClosing(target);
 * <Dialog open={target != null} onClose={() => setTarget(null)} title={…}>
 *   {shown ? <Detail record={shown} /> : null}
 * </Dialog>
 */
export function useRetainedWhileClosing<T>(value: T | null | undefined): T | null | undefined {
  const [kept, setKept] = React.useState(value);
  if (value != null && value !== kept) setKept(value);
  return value ?? kept;
}

/**
 * The one modal. Centered over the shared ink scrim (`--scrim`), rendered
 * through a portal to `document.body` so `overflow` and transformed ancestors
 * never clip it. Keyboard and focus come from `useModalDialog`: focus moves
 * in, Tab wraps, Escape closes the innermost dialog, focus returns on close.
 * Enters with a fade and an 8px rise (fade only under reduced motion).
 *
 * Use it for create, confirm and focused tasks. Record detail belongs in a
 * `Disclosure`; row actions belong in a `Menu`. No right-side drawers.
 *
 * @example
 * <Dialog open={open} title="Remove Priya Mehta" onClose={close} dismissOnScrim={false}
 *   footer={<><Button variant="secondary" onClick={close}>Cancel</Button>
 *            <Button onClick={remove}>Remove</Button></>}>
 *   …
 * </Dialog>
 */
export function Dialog({ open, ...props }: DialogProps) {
  const canPortal = useCanPortal();
  // A parent that mounts the Dialog conditionally can wrap that condition in
  // `<AnimatePresence>`: while it leaves, `present` turns false, the frame
  // plays its exit, then the parent removes it. Outside AnimatePresence
  // `present` is always true.
  const [present, safeToRemove] = usePresence();
  const shown = open && present;
  const presentRef = React.useRef(present);
  React.useEffect(() => {
    presentRef.current = present;
  }, [present]);
  React.useEffect(() => {
    // Nothing on screen to animate out: release the parent at once.
    if (!present && (!open || !canPortal)) safeToRemove?.();
  }, [present, open, canPortal, safeToRemove]);
  if (!canPortal) return null;
  return createPortal(
    <AnimatePresence
      onExitComplete={() => {
        if (!presentRef.current) safeToRemove?.();
      }}
    >
      {shown ? <DialogFrame key="dialog" {...props} /> : null}
    </AnimatePresence>,
    document.body,
  );
}

function DialogFrame({
  onClose,
  title,
  eyebrow,
  description,
  ariaLabel,
  size = 'md',
  footer,
  initialFocus,
  dismissOnScrim = true,
  headless = false,
  children,
}: Omit<DialogProps, 'open'>) {
  const reduce = useReducedMotion() ?? false;
  const isPresent = useIsPresent();
  const titleId = React.useId();
  const descriptionId = React.useId();

  const panelRef = React.useRef<HTMLDivElement | null>(null);
  // The panel element, for floating layers (Menu) to portal into.
  const [panel, setPanel] = React.useState<HTMLDivElement | null>(null);
  const setPanelRef = React.useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setPanel(node);
  }, []);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const footerRef = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const autoFocusRef = React.useRef<HTMLElement | null>(null);

  // Resolved before useModalDialog's effect runs (layout effects go first).
  React.useLayoutEffect(() => {
    autoFocusRef.current =
      (bodyRef.current ? focusableIn(bodyRef.current)[0] : undefined) ??
      (footerRef.current ? focusableIn(footerRef.current)[0] : undefined) ??
      closeRef.current;
  }, []);

  // Leaving (exit motion running) releases Escape, Tab and focus at once.
  useModalDialog(panelRef, onClose, {
    active: isPresent,
    initialFocus: initialFocus ?? autoFocusRef,
  });

  // A press that starts in the panel and ends on the scrim is a drag, not a
  // dismissal. Starts true so a bare click (no mousedown) still counts.
  const pressedOnScrim = React.useRef(true);
  const panelMotion = travel(reduce);

  return (
    <motion.div
      data-overlay-scrim=""
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim)] p-[var(--space-4)]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={overlayTransition}
      // Leaving: clicks pass through to the page instead of closing again.
      style={{ pointerEvents: isPresent ? undefined : 'none' }}
      onMouseDown={(event) => {
        pressedOnScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        if (dismissOnScrim && pressedOnScrim.current) onClose();
        pressedOnScrim.current = true;
      }}
    >
      <motion.div
        ref={setPanelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        initial={panelMotion.initial}
        animate={panelMotion.animate}
        exit={panelMotion.exit}
        transition={overlayTransition}
        className={`flex max-h-full w-full ${WIDTH[size]} flex-col rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)] shadow-[var(--shadow-ambient)] focus:outline-none`}
      >
        {headless ? null : <div className="flex items-start gap-[var(--space-3)]">
          <div className="min-w-0 flex-1">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2
              id={titleId}
              className={`${eyebrow ? 'mt-1 ' : ''}text-[length:var(--text-lg)] font-semibold text-[var(--ink)]`}
            >
              {title}
            </h2>
            {description ? (
              <p
                id={descriptionId}
                className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
              >
                {description}
              </p>
            ) : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-secondary)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <X className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>}

        <OverlayContainerContext.Provider value={panel}>
          {children ? (
            <div ref={bodyRef} className={`-mx-1 ${headless ? '' : 'mt-[var(--space-2)] '}min-h-0 overflow-y-auto px-1 pb-1`}>
              {children}
            </div>
          ) : null}

          {footer ? (
            <div
              ref={footerRef}
              className="mt-[var(--space-4)] flex flex-wrap items-center justify-end gap-[var(--space-2)]"
            >
              {footer}
            </div>
          ) : null}
        </OverlayContainerContext.Provider>
      </motion.div>
    </motion.div>
  );
}

export default Dialog;
