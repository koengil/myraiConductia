'use client';

import * as React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';

import { overlayTransition } from './motion';

type GroupContext = {
  isOpen: (value: string) => boolean;
  toggle: (value: string) => void;
};

const DisclosureGroupContext = React.createContext<GroupContext | null>(null);

export type DisclosureGroupProps = {
  /** Opening one row closes the others (accordion). Default `false`. */
  single?: boolean;
  /** `value`s of the rows that start open. */
  defaultOpen?: string[];
  children: React.ReactNode;
};

/**
 * Coordinates the `Disclosure` rows inside it. With `single`, opening one
 * row closes the one that was open, so a list of records shows one detail
 * at a time. Give each row a `value` to open it from `defaultOpen`.
 */
export function DisclosureGroup({ single = false, defaultOpen = [], children }: DisclosureGroupProps) {
  const [openValues, setOpenValues] = React.useState<string[]>(() =>
    single ? defaultOpen.slice(0, 1) : defaultOpen,
  );
  const context = React.useMemo<GroupContext>(
    () => ({
      isOpen: (value) => openValues.includes(value),
      toggle: (value) =>
        setOpenValues((current) => {
          if (current.includes(value)) return current.filter((v) => v !== value);
          return single ? [value] : [...current, value];
        }),
    }),
    [openValues, single],
  );
  return <DisclosureGroupContext.Provider value={context}>{children}</DisclosureGroupContext.Provider>;
}

export type DisclosureProps = {
  /** The row's main text. Lives inside the header button. */
  title: React.ReactNode;
  /**
   * Quiet trailing text on the row, e.g. a date. Text only: it sits inside
   * the header button, so nothing interactive and no chip with its own
   * screen-reader text. Use `actions` for those.
   */
  meta?: React.ReactNode;
  /**
   * Controls on the row (a `Menu`, a button, a `PreviewChip`). Rendered
   * beside the header button, never inside it.
   */
  actions?: React.ReactNode;
  /**
   * A control before the header button, e.g. a row's select checkbox.
   * Rendered beside the button, never inside it, centred on the header.
   */
  leading?: React.ReactNode;
  /** Identifies the row inside a `DisclosureGroup`. */
  value?: string;
  /** Start open (standalone, uncontrolled). Ignored inside a group: use the group's `defaultOpen`. */
  defaultOpen?: boolean;
  /** Controlled open state (standalone). Ignored inside a group, which owns the state. */
  open?: boolean;
  /** Called with the next open state when the header is pressed (standalone). Ignored inside a group. */
  onOpenChange?: (open: boolean) => void;
  /** Extra classes for the row wrapper. */
  className?: string;
  /** The record detail shown under the row when open. */
  children: React.ReactNode;
};

/**
 * Inline expand/collapse row for record detail (the "hamburger" pattern):
 * detail opens under the row the user pressed, never in a drawer. The header
 * is a full-width button with `aria-expanded` and `aria-controls`; the panel
 * animates its height on the overlay clock (fade only under reduced motion).
 * Inside a `DisclosureGroup` the group owns the open state; standalone it is
 * uncontrolled (`defaultOpen`) or controlled (`open` + `onOpenChange`).
 */
export function Disclosure({
  title,
  meta,
  actions,
  leading,
  value,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
  children,
}: DisclosureProps) {
  const group = React.useContext(DisclosureGroupContext);
  const reduce = useReducedMotion() ?? false;
  const autoId = React.useId();
  const key = value ?? autoId;
  const panelId = `${autoId}-panel`;
  const [ownOpen, setOwnOpen] = React.useState(defaultOpen);
  // Clip only while the height animates, so a settled panel never clips
  // a focus ring or anything that overflows it.
  const [animating, setAnimating] = React.useState(false);

  const open = group ? group.isOpen(key) : (openProp ?? ownOpen);

  function toggle() {
    if (group) {
      group.toggle(key);
      return;
    }
    if (openProp === undefined) setOwnOpen(!open);
    onOpenChange?.(!open);
  }

  const panelMotion = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, height: 0 },
        animate: { opacity: 1, height: 'auto' },
        exit: { opacity: 0, height: 0 },
      };

  return (
    <div className={['border-b border-[var(--stroke)] last:border-b-0', className].filter(Boolean).join(' ')}>
      <div className="flex items-center">
        {leading ? (
          <div className="flex shrink-0 items-center pl-[var(--space-3)]">{leading}</div>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={toggle}
          className="flex min-h-12 min-w-0 flex-1 items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] text-left text-[length:var(--text-sm)] text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
        >
          <span className="min-w-0 flex-1">{title}</span>
          {meta ? (
            <span className="shrink-0 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{meta}</span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            strokeWidth={1.75}
            className={`size-4 shrink-0 text-[var(--ink-tertiary)] transition-transform duration-150 motion-reduce:transition-none ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>
        {actions ? (
          <div className="flex shrink-0 items-center gap-[var(--space-2)] pl-[var(--space-2)] pr-[var(--space-3)]">
            {actions}
          </div>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="panel"
            id={panelId}
            data-disclosure-panel=""
            initial={panelMotion.initial}
            animate={panelMotion.animate}
            exit={panelMotion.exit}
            transition={overlayTransition}
            onAnimationStart={() => setAnimating(true)}
            onAnimationComplete={() => setAnimating(false)}
            className={animating ? 'overflow-hidden' : undefined}
          >
            <div className="px-[var(--space-3)] pb-[var(--space-3)]">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export default Disclosure;
