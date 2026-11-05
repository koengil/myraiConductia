'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import { OVERLAY_RISE_PX, overlayTransition, travel } from './motion';

/** What the trigger button spreads, so the Popover owns its wiring. */
export type PopoverTriggerProps = {
  ref: React.RefObject<HTMLButtonElement | null>;
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  'aria-haspopup': 'dialog';
  onClick: () => void;
};

export type PopoverProps = {
  /** Whether the panel shows. The caller owns it, so a choice inside can close it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the panel (`aria-label`), e.g. "Notifications" or "Switch deal". */
  label: string;
  /**
   * Renders the trigger button. Spread the props onto a `<button>`; keep your
   * own `aria-label` and styling.
   */
  trigger: (props: PopoverTriggerProps) => React.ReactNode;
  /**
   * Classes for the panel: where it sits against the trigger (e.g.
   * `left-0 top-[calc(100%+6px)]`), its width and surface.
   */
  panelClassName?: string;
  panelStyle?: React.CSSProperties;
  /** Which way the panel opens, for the direction of its entry. Default `below`. */
  side?: 'below' | 'above';
  /** Classes for the wrapper around the trigger and panel. */
  className?: string;
  /**
   * The trigger's ref, when the caller needs it, e.g. to return focus there
   * before opening a Dialog from inside the panel.
   */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
};

/**
 * The non-modal panel anchored to its trigger, for content a `Menu` cannot
 * hold: a search field, a list to pick from, links, approve and deny buttons,
 * a status line. It is a non-modal dialog (`role="dialog"` without
 * `aria-modal`), named by `label`, rendered right after its trigger so Tab
 * moves from the trigger into the panel and on through it. There is no focus
 * trap: Tab out of the panel closes it, Escape closes it and, when focus is
 * inside the panel, returns focus to the trigger, and a press outside closes it
 * where the user is. Inside a Dialog, one Escape closes only the Popover.
 *
 * Enters on the overlay clock (4px drop below the trigger, 4px rise above it;
 * fade only under reduced motion) and closes at once, like `Menu`.
 *
 * @example
 * <Popover open={open} onOpenChange={setOpen} label="Notifications"
 *   panelClassName="right-0 top-[calc(100%+6px)] w-[320px] …"
 *   trigger={(props) => <button type="button" {...props} aria-label="Notifications">…</button>}>
 *   …
 * </Popover>
 */
export function Popover({
  open,
  onOpenChange,
  label,
  trigger,
  panelClassName,
  panelStyle,
  side = 'below',
  className,
  triggerRef: externalTriggerRef,
  children,
}: PopoverProps) {
  const reduce = useReducedMotion() ?? false;
  const panelId = React.useId();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const ownTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const triggerRef = externalTriggerRef ?? ownTriggerRef;
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  React.useEffect(() => {
    if (!open) return;
    const close = () => onOpenChangeRef.current(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Marked handled, so an enclosing Dialog's window listener leaves it alone.
      event.preventDefault();
      const active = document.activeElement;
      const inside = !active || active === document.body || rootRef.current?.contains(active);
      close();
      if (inside) triggerRef.current?.focus();
    };
    const onPress = (event: Event) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close();
    };
    // On the root first: an Escape from inside reaches it before any window
    // listener (a Dialog's). The window listener covers focus elsewhere.
    const root = rootRef.current;
    root?.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('mousedown', onPress);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      root?.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPress);
      document.removeEventListener('mousedown', onPress);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, triggerRef]);

  const panelMotion = travel(reduce, side === 'below' ? -OVERLAY_RISE_PX / 2 : OVERLAY_RISE_PX / 2);

  return (
    <div ref={rootRef} className={['relative', className].filter(Boolean).join(' ')}>
      {trigger({
        ref: triggerRef,
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
        'aria-haspopup': 'dialog',
        onClick: () => onOpenChange(!open),
      })}
      {open ? (
        <motion.div
          id={panelId}
          role="dialog"
          aria-label={label}
          data-overlay-popover=""
          initial={panelMotion.initial}
          animate={panelMotion.animate}
          transition={overlayTransition}
          className={['absolute z-50', panelClassName].filter(Boolean).join(' ')}
          style={panelStyle}
        >
          {children}
        </motion.div>
      ) : null}
    </div>
  );
}

export default Popover;
