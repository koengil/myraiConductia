'use client';

import * as React from 'react';
import { Building2, Check, ChevronDown, Plus, Search } from 'lucide-react';

import { Popover } from '@/components/overlay';
import { phaseForStep } from '@/lib/rail/dealRail';
import type { FixtureDeal } from '@/lib/rail/deals';
import { findDealBySegment, dealMatchesSegment } from '@/lib/deals/useDeals';
import { DealsUnavailableCompact } from './DealsUnavailable';

/** Filter deals by code name or deal code (client-side, instant). */
export function filterDeals(
  deals: readonly FixtureDeal[],
  query: string,
): FixtureDeal[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...deals];
  return deals.filter(
    (d) =>
      d.codename.toLowerCase().includes(q) || d.code.toLowerCase().includes(q),
  );
}

type DealSelectMenuProps = {
  deals: readonly FixtureDeal[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Extra rows below the deal list (e.g. New deal). */
  footer?: React.ReactNode;
  /** When true, focus the search field on mount. */
  autoFocus?: boolean;
  /** The deal list failed (#162): the menu says so, with Try again, instead
   *  of an empty list. The footer (New deal) stays. */
  unavailable?: { onRetry: () => void } | null;
};

/** Searchable deal list — the shared inner panel for switcher surfaces. */
export function DealSelectMenu({
  deals,
  activeId,
  onSelect,
  footer,
  autoFocus = true,
  unavailable = null,
}: DealSelectMenuProps) {
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const filtered = React.useMemo(() => filterDeals(deals, query), [deals, query]);

  React.useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  if (unavailable) {
    return (
      <>
        <DealsUnavailableCompact
          onRetry={unavailable.onRetry}
          className="px-[var(--space-4)] py-[var(--space-3)]"
        />
        {footer}
      </>
    );
  }

  return (
    <>
      <div className="relative border-b border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)]">
        <Search
          size={14}
          strokeWidth={1.75}
          aria-hidden
          className="pointer-events-none absolute left-[calc(var(--space-3)+10px)] top-1/2 -translate-y-1/2 text-[var(--ink-quiet)]"
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search deals…"
          aria-label="Search deals"
          className="w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] py-[var(--space-2)] pl-[calc(var(--space-3)+18px)] pr-[var(--space-3)] text-(length:--text-sm) text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </div>

      <ul
        role="listbox"
        aria-label="Deals"
        className="max-h-[min(280px,50vh)] list-none overflow-y-auto p-0"
      >
        {filtered.map((d) => {
          const active = activeId != null && dealMatchesSegment(d, activeId);
          const dPhase = phaseForStep(d.cursorStepId);
          return (
            <li key={d.id}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => onSelect(d.id)}
                className={
                  'flex min-h-11 w-full items-center gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-2)] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ' +
                  (active
                    ? 'bg-[var(--accent-soft)]'
                    : 'hover:bg-[var(--surface-raised)] focus-visible:bg-[var(--surface-raised)]')
                }
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={
                      'truncate text-(length:--text-sm) font-medium ' +
                      (active ? 'text-[var(--accent)]' : 'text-[var(--ink)]')
                    }
                  >
                    {d.codename}
                  </span>
                  <span className="truncate font-mono text-(length:--text-xxs) tabular-nums text-[var(--ink-tertiary)]">
                    {d.code}
                    {dPhase ? ` · ${dPhase.name}` : ''}
                  </span>
                </span>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {active ? (
                    <Check size={14} strokeWidth={1.75} className="text-[var(--accent)]" aria-hidden />
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li
            role="status"
            className="px-[var(--space-4)] py-[var(--space-3)] text-(length:--text-sm) text-[var(--ink-secondary)]"
          >
            No deals match &ldquo;{query.trim()}&rdquo;.
          </li>
        ) : null}
      </ul>

      {footer}
    </>
  );
}

const footerButtonClass =
  'flex min-h-11 w-full items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-2)] text-left text-[length:var(--text-sm)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]';

/** Shared footer row for the deal switcher panels: a plain "New deal" button. */
export function DealSelectMenuFooter({
  showNewDeal,
  onNewDeal,
}: {
  showNewDeal: boolean;
  onNewDeal: () => void;
}) {
  if (!showNewDeal) return null;

  return (
    <>
      <div className="my-[var(--space-1)] h-px bg-[var(--stroke)]" />
      <button type="button" onClick={onNewDeal} className={footerButtonClass}>
        <Plus size={16} strokeWidth={1.75} aria-hidden className="text-[var(--ink-tertiary)]" />
        New deal
      </button>
    </>
  );
}

type SidebarDealSelectProps = {
  deals: readonly FixtureDeal[];
  activeId: string | null;
  /** Resolved deal for the URL segment when the list row is missing or keyed differently. */
  activeDeal?: FixtureDeal | null;
  onSelect: (id: string) => void;
  menuFooter?: {
    showNewDeal: boolean;
    onNewDeal: () => void;
  };
  /** The deal list failed (#162): the list slot says so, with Try again. */
  unavailable?: { onRetry: () => void } | null;
};

/** Compact searchable deal picker for the sidebar Deals section. */
export function SidebarDealSelect({
  deals,
  activeId,
  activeDeal: activeDealProp,
  onSelect,
  menuFooter,
  unavailable = null,
}: SidebarDealSelectProps) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const activeDeal =
    activeDealProp ??
    (activeId != null ? findDealBySegment(deals, activeId) : null);

  const pick = (id: string) => {
    setOpen(false);
    onSelect(id);
  };

  if (unavailable) {
    return (
      <section className="mt-5">
        <p className="px-3 pb-1 text-[11px] font-semibold text-(--sidebar-item)">
          Deals
        </p>
        <DealsUnavailableCompact onRetry={unavailable.onRetry} className="px-3 py-2" />
      </section>
    );
  }

  return (
    <section className="mt-5">
      <p className="px-3 pb-1 text-[11px] font-semibold text-(--sidebar-item)">
        Deals
      </p>
      <Popover
        open={open}
        onOpenChange={setOpen}
        label="Switch deal"
        className="px-3"
        triggerRef={triggerRef}
        panelClassName="left-3 right-3 top-[calc(100%+4px)] overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] shadow-[var(--shadow-ambient)]"
        trigger={(props) => (
          <button
            type="button"
            {...props}
            aria-label={
              activeDeal
                ? `Deal: ${activeDeal.codename}. Switch deal`
                : 'Select a deal'
            }
            className={[
              'flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-[length:var(--text-md)] transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              activeDeal
                ? 'bg-(--sidebar-item-active-bg) font-medium text-(--sidebar-item-active-text)'
                : 'text-(--sidebar-item) hover:bg-(--sidebar-item-hover-bg) hover:text-(--sidebar-item-hover-text)',
            ].join(' ')}
          >
            <Building2 size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 opacity-80" />
            <span className="min-w-0 flex-1 truncate text-left">
              {activeDeal?.codename ?? 'Select a deal'}
            </span>
            <ChevronDown
              size={16}
              strokeWidth={1.75}
              className={
                'shrink-0 opacity-70 transition-transform ' + (open ? 'rotate-180' : '')
              }
              aria-hidden
            />
          </button>
        )}
      >
        <DealSelectMenu
          key="sidebar-deal-menu"
          deals={deals}
          activeId={activeId}
          onSelect={pick}
          footer={
            menuFooter ? (
              <DealSelectMenuFooter
                showNewDeal={menuFooter.showNewDeal}
                onNewDeal={() => {
                  // Close to the trigger first, so the New mandate dialog
                  // returns focus there when it closes.
                  setOpen(false);
                  triggerRef.current?.focus();
                  menuFooter.onNewDeal();
                }}
              />
            ) : null
          }
        />
      </Popover>
    </section>
  );
}
