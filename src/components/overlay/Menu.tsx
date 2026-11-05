'use client';

import * as React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, MoreHorizontal } from 'lucide-react';

import { useOverlayContainer } from './container';
import { OVERLAY_RISE_PX, overlayTransition, travel } from './motion';

/** One row in a `Menu`. */
export type MenuItem = {
  /** Stable key. */
  id: string;
  /** Visible label: a verb and its record, e.g. "Remove from deal". */
  label: string;
  /**
   * Optional second line under the label, e.g. what a skill does. It is the
   * item's description (`aria-describedby`), not part of its name; the name
   * and typeahead use `label` alone. Shown on picker rows too.
   */
  description?: string;
  /** Runs after the menu closes and focus has returned to the trigger. */
  onSelect: () => void;
  disabled?: boolean;
  /** Renders the label in the negative tone. Confirm the action in a Dialog. */
  destructive?: boolean;
  /**
   * Set on every item to make the menu a picker: items become
   * `menuitemradio` with `aria-checked`, and the checked one shows a tick.
   */
  checked?: boolean;
};

export type MenuProps = {
  /**
   * Names the menu, e.g. "Actions for Priya Mehta". Names an icon-only
   * trigger, and is read before a visible trigger's text ("Sort by: Newest
   * first").
   */
  label: string;
  items: MenuItem[];
  /**
   * Visible trigger content (e.g. the current choice in a picker). Omit for
   * the three-dot icon button.
   */
  trigger?: React.ReactNode;
  /** Extra classes for the trigger button. */
  triggerClassName?: string;
  /** Which trigger edge the menu lines up with. Default `end` (right). */
  align?: 'start' | 'end';
  /** The trigger's tabIndex, for a menu inside a roving-tabindex group
   *  (a rail card's menu is a tab stop only on its column's stop). */
  triggerTabIndex?: number;
};

const triggerBase =
  'inline-flex h-[34px] items-center justify-center rounded-[var(--radius-control)] border border-[var(--stroke-strong)] bg-[var(--surface)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:bg-[var(--surface-raised)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60';

const itemBase =
  'flex w-full cursor-default select-none items-center gap-[var(--space-2)] rounded-[var(--radius-control)] px-[var(--space-3)] py-[7px] text-left text-[length:var(--text-xs)] font-medium outline-none transition-colors data-[highlighted]:bg-[var(--surface-subtle)] data-[disabled]:opacity-60 focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

/**
 * The actions menu (three-dot) and simple picker, built on Radix
 * DropdownMenu behind these props. `role="menu"`; Enter, Space or ArrowDown
 * on the trigger opens it; arrows (wrapping), Home/End and typeahead move;
 * Escape and Tab close it and return focus to the trigger; an outside press
 * closes it where the user is. Choosing an item closes the menu, returns
 * focus to the trigger, then runs `onSelect`, so a Dialog opened from an
 * item restores focus to the trigger.
 *
 * The panel portals (to the enclosing Dialog's panel, else `document.body`)
 * and flips to stay on screen, so no row, Disclosure or Dialog body clips
 * it. Escape inside a Dialog closes only the menu. Enters on the overlay
 * clock with a 4px drop (fade only under reduced motion), closes at once.
 *
 * Tests: open with `fireEvent.keyDown(trigger, { key: 'Enter' })` or
 * `fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })`; a bare
 * `fireEvent.click` does not open a Radix menu.
 *
 * @example
 * <Menu label={`Actions for ${name}`} items={[
 *   { id: 'role', label: 'Change role', onSelect: openRoleDialog },
 *   { id: 'remove', label: 'Remove from deal', destructive: true, onSelect: confirmRemove },
 * ]} />
 */
export function Menu({
  label,
  items,
  trigger,
  triggerClassName,
  align = 'end',
  triggerTabIndex,
}: MenuProps) {
  const [open, setOpen] = React.useState(false);
  const reduce = useReducedMotion() ?? false;
  const container = useOverlayContainer();
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuId = React.useId();
  const picker = items.some((item) => item.checked !== undefined);
  const described = items.some((item) => item.description);
  const checkedId = items.find((item) => item.checked)?.id ?? '';

  // We own focus return: Radix would refocus the trigger a tick later, which
  // would steal focus from a Dialog an item just opened.
  function closeToTrigger() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function select(item: MenuItem) {
    closeToTrigger();
    item.onSelect();
  }

  if (items.length === 0) return null;
  const panelMotion = travel(reduce, -OVERLAY_RISE_PX / 2);

  const rows = items.map((item) => {
    const labelId = `${menuId}-${item.id}-label`;
    const descriptionId = `${menuId}-${item.id}-description`;
    // Shared by a plain item and a picker (radio) item.
    const itemProps = {
      disabled: item.disabled,
      className: `${itemBase} ${item.destructive ? 'text-[var(--negative)]' : 'text-[var(--ink)]'}`,
      textValue: item.label,
      'aria-labelledby': item.description ? labelId : undefined,
      'aria-describedby': item.description ? descriptionId : undefined,
      onSelect: () => select(item),
    };
    const content = item.description ? (
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <span id={labelId}>{item.label}</span>
        <span id={descriptionId} className="font-normal text-[var(--ink-secondary)]">
          {item.description}
        </span>
      </span>
    ) : (
      <span className="min-w-0 flex-1">{item.label}</span>
    );
    if (picker) {
      return (
        <DropdownMenu.RadioItem key={item.id} value={item.id} {...itemProps}>
          <span className="inline-flex size-3.5 shrink-0" aria-hidden="true">
            <DropdownMenu.ItemIndicator>
              <Check className="size-3.5" strokeWidth={1.75} />
            </DropdownMenu.ItemIndicator>
          </span>
          {content}
        </DropdownMenu.RadioItem>
      );
    }
    return (
      <DropdownMenu.Item key={item.id} {...itemProps}>
        {content}
      </DropdownMenu.Item>
    );
  });

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          tabIndex={triggerTabIndex}
          aria-label={trigger ? undefined : label}
          className={[triggerBase, trigger ? 'gap-[var(--space-2)] px-[var(--space-3)]' : 'w-[34px]', triggerClassName]
            .filter(Boolean)
            .join(' ')}
        >
          {trigger ? (
            <>
              <span className="sr-only">{label}:</span> {trigger}
            </>
          ) : (
            <MoreHorizontal className="size-4" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
          asChild
          loop
          align={align}
          side="bottom"
          sideOffset={8}
          collisionPadding={8}
          aria-label={label}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            // Radix calls this from a document capture listener, before React
            // re-renders. Stopping the native event here keeps it from ever
            // reaching an enclosing Dialog's window listener.
            event.stopPropagation();
            closeToTrigger();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault();
              event.stopPropagation();
              closeToTrigger();
            }
          }}
        >
          <motion.div
            initial={panelMotion.initial}
            animate={panelMotion.animate}
            transition={overlayTransition}
            className={`z-[110] min-w-[11rem] ${described ? 'max-w-[min(22rem,calc(100vw-16px))]' : ''} rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-1)] shadow-[var(--shadow-ambient)] focus:outline-none`}
          >
            {picker ? <DropdownMenu.RadioGroup value={checkedId}>{rows}</DropdownMenu.RadioGroup> : rows}
          </motion.div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export default Menu;
