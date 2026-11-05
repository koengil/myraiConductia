'use client';

import * as React from 'react';
import { Search } from 'lucide-react';

import type { RailViewFilter as Filter } from '@/lib/prefs/localPrefs';

/**
 * Above the rail: finding a step by name or number, what to show, and the rail's actions.
 */
export function RailBoardTools({
  views,
  trailing,
  query,
  onQueryChange,
  matchCount,
}: {
  /** After the search: the board's views. */
  views?: React.ReactNode;
  /** At the far end of the row: the rail's actions. */
  trailing?: React.ReactNode;
  query: string;
  onQueryChange: (next: string) => void;
  /** How many steps answer the search. Null while there is no search. */
  matchCount: number | null;
}) {
  return (
    <div className="mb-[var(--space-3)] flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
      <div className="relative w-full sm:w-[280px]">
        <Search
          aria-hidden
          size={14}
          strokeWidth={1.75}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-tertiary)]"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              e.stopPropagation();
              onQueryChange('');
            }
          }}
          aria-label="Search steps"
          placeholder="Search steps by name or number"
          className="h-[30px] w-full rounded-[var(--radius-control)] bg-[var(--surface-subtle)] pl-8 pr-3 text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </div>
      {views}
      <p role="status" className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        {matchCount === null
          ? ''
          : matchCount === 0
            ? 'No steps match.'
            : `${matchCount} ${matchCount === 1 ? 'step matches' : 'steps match'}.`}
      </p>
      {trailing ? (
        <div
          // 44px touch targets below sm; the desktop sizes stay.
          data-rail-header-actions
          className="ml-auto flex flex-wrap items-center gap-[var(--space-2)] [&_button]:min-h-11 sm:[&_button]:h-[30px] sm:[&_button]:min-h-0"
        >
          {trailing}
        </div>
      ) : null}
    </div>
  );
}

/**
 * On a phase's header: how much of it nobody owns and how much is yours. Each
 * number turns on that view for the board; pressed again, it goes back to All.
 */
export function PhaseViewLinks({
  unassigned,
  mine,
  value,
  onChange,
}: {
  unassigned: number;
  mine: number;
  value: Filter;
  onChange: (next: Filter) => void;
}) {
  const links: { id: Filter; label: string; count: number }[] = [
    { id: 'unassigned', label: 'unassigned', count: unassigned },
    { id: 'mine', label: 'yours', count: mine },
  ];
  const shown = links.filter((link) => link.count > 0);
  if (shown.length === 0) return null;
  return (
    // Above the header toggle's hit area, which covers the whole header.
    <div className="relative z-[1] mt-[var(--space-1)] flex flex-wrap gap-x-[var(--space-2)]">
      {shown.map((link) => (
        <button
          key={link.id}
          type="button"
          aria-pressed={value === link.id}
          onClick={() => onChange(value === link.id ? 'all' : link.id)}
          className={`rounded-[var(--radius-input)] text-[length:var(--text-xs)] underline-offset-2 outline-offset-2 transition-colors hover:text-[var(--ink)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ${
            value === link.id ? 'font-medium text-[var(--ink)] underline' : 'text-[var(--ink-secondary)]'
          }`}
        >
          {link.count} {link.label}
        </button>
      ))}
    </div>
  );
}

export default RailBoardTools;
