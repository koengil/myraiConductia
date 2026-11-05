'use client';

import * as React from 'react';

export type SegmentedControlItem = {
  id: string;
  label: string;
  /** How many things the item holds, beside its label. */
  count?: number;
};

type Surface = 'light' | 'dark';

/*
 * Workbench segmented pill tabs (kit §02). The register follows the ground
 * the group is painted on: on light surfaces the active pill is field gray
 * with ink; on the canvas stage the pill is a light wash with on-dark ink.
 */
const surfaces: Record<Surface, { selected: string; unselected: string; focus: string; indicator: string }> = {
  light: {
    // Selected text is ink (well over 4.5:1 on the field gray); the
    // indicator under it is ink too (over 3:1), so the choice never rests on
    // the faint fill alone.
    selected: 'bg-[var(--surface-subtle)] text-[var(--ink)]',
    indicator: 'bg-[var(--ink)]',
    unselected:
      'text-[var(--ink-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]',
    focus:
      'focus-visible:ring-[var(--accent)] focus-visible:ring-offset-[var(--surface-warm)]',
  },
  dark: {
    selected: 'bg-[rgb(245_242_235_/_0.10)] text-[var(--ink-on-dark)]',
    indicator: 'bg-[var(--ink-on-dark)]',
    unselected:
      'text-[var(--ink-on-dark-secondary)] hover:bg-[rgb(245_242_235_/_0.06)] hover:text-[var(--ink-on-dark)]',
    focus:
      'focus-visible:ring-[var(--ink-on-dark)] focus-visible:ring-offset-[var(--canvas-bg)]',
  },
};

export type SegmentedControlProps = {
  items: readonly SegmentedControlItem[];
  value: string;
  onChange: (id: string) => void;
  idBase: string;
  'aria-label': string;
  className?: string;
  surface?: Surface;
  /**
   * The id of the panel a tab controls, when that panel is on the page.
   * aria-controls is emitted only for the ids this returns: a tab
   * never points at a panel that does not exist.
   */
  panelIdFor?: (itemId: string) => string | undefined;
};

export function SegmentedControl({
  items,
  value,
  onChange,
  idBase,
  'aria-label': ariaLabel,
  className,
  surface = 'light',
  panelIdFor,
}: SegmentedControlProps) {
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const register = surfaces[surface];

  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === value),
  );

  function focusAndSelect(index: number) {
    const next = (index + items.length) % items.length;
    const item = items[next];
    if (!item) return;
    onChange(item.id);
    tabRefs.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusAndSelect(activeIndex + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusAndSelect(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAndSelect(0);
        break;
      case 'End':
        event.preventDefault();
        focusAndSelect(items.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={[
        // Workbench segmented pill tabs (kit §02): container-less group —
        // no border, no fill, no shadow; the active item carries the pill.
        'inline-flex w-full flex-wrap items-stretch gap-[var(--space-1)]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${item.id}`}
            aria-label={item.count !== undefined ? `${item.label} ${item.count}` : undefined}
            aria-selected={selected}
            aria-controls={panelIdFor?.(item.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={onKeyDown}
            className={[
              'relative inline-flex flex-1 items-center justify-center ' +
                'rounded-full px-[var(--space-4)] py-[var(--space-2)] ' +
                'font-sans text-[length:var(--text-sm)] font-medium whitespace-nowrap select-none ' +
                'transition-[background-color,color] duration-150 ease-out ' +
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
              register.focus,
              selected ? register.selected : register.unselected,
            ].join(' ')}
          >
            <span>{item.label}</span>
            {item.count !== undefined ? (
              <span className="ml-1.5 font-normal tabular-nums opacity-70">{item.count}</span>
            ) : null}
            {/* The selected pill carries an ink underline as well as the
                field-gray fill, so the state reads at 3:1 or better. */}
            <span
              aria-hidden="true"
              data-segment-indicator
              className={[
                'absolute inset-x-[var(--space-3)] bottom-[2px] h-[2px] rounded-full',
                selected ? register.indicator : 'bg-transparent opacity-0',
              ].join(' ')}
            />
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
