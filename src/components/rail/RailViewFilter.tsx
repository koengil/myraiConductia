'use client';

import * as React from 'react';

import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/atoms/Button';
import { Popover } from '@/components/overlay/Popover';
import type { RailView, RailViewFilter as Filter } from '@/lib/prefs/localPrefs';
import type { ProjectRailStep } from '@/lib/rail/projectRail';
import type { StepState } from './stepState';

/** The audit read failed and nothing good is on screen. */
export const ACTIVITY_FAILED_COPY = 'Activity could not be loaded.';

export const RAIL_VIEW_OPTIONS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'mine', label: 'Mine' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'has_activity', label: 'Has activity' },
];

/** Whether a step shows under a view. "All" is the whole rail; the others
 *  leave out steps before the deal's entry, which are reference only.
 *  "Open" is the work still to do; "Unassigned" is the part nobody owns yet. */
export function stepInView(
  filter: Filter,
  step: ProjectRailStep,
  state: StepState,
  facts: { ownerId: string | null; meId: string | null; hasActivity: boolean },
): boolean {
  if (filter === 'all') return true;
  if (state === 'prior') return false;
  if (filter === 'open') return state === 'active' || state === 'todo';
  if (filter === 'mine') return facts.meId !== null && facts.ownerId === facts.meId;
  if (filter === 'unassigned') return facts.ownerId === null && (state === 'active' || state === 'todo');
  return facts.hasActivity;
}

/** Whether a step answers a search: by the number on its card, or by its title. */
export function stepMatchesSearch(query: string, title: string, number: number): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  return title.toLowerCase().includes(wanted) || (/^\d+$/.test(wanted) && Number(wanted) === number);
}

/**
 * The rail's personal views, chosen from a menu and applied together: a step
 * shows when it is in any view ticked, and none ticked is the whole rail. The
 * choice is kept in this browser only. Shared, per-deal saved views
 * are handoff entry E15 "Saved views: per user or shared with the deal".
 */
export function RailViewFilter({
  value,
  onChange,
  counts,
  shownCount,
  capped,
  activityFailed = false,
  onRetryActivity,
}: {
  value: readonly RailView[];
  onChange: (next: RailView[]) => void;
  /** How many steps each view holds. A view left out could not be counted. */
  counts?: Partial<Record<Filter, number>>;
  /** How many steps the applied views show. */
  shownCount?: number;
  /** The activity read hit its cap: older activity may not count toward "Has activity". */
  capped?: boolean;
  /** The activity read failed with no good read to show: say so, with a retry. */
  activityFailed?: boolean;
  onRetryActivity?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<readonly RailView[]>(value);
  const views = RAIL_VIEW_OPTIONS.filter((option): option is { id: RailView; label: string } => option.id !== 'all');
  const chosen = views.filter((option) => value.includes(option.id));
  const label = chosen.length === 0 ? 'All' : chosen.length === 1 ? chosen[0].label : `${chosen.length} views`;
  const toggle = (view: RailView) =>
    setDraft((prev) => (prev.includes(view) ? prev.filter((id) => id !== view) : [...prev, view]));
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          // Each opening starts from what is applied: closing without Apply changes nothing.
          if (next) setDraft(value);
          setOpen(next);
        }}
        label="Show"
        panelClassName="left-0 top-[calc(100%+6px)] flex w-[240px] flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)] shadow-[var(--elev-2)]"
        trigger={(props) => (
          <button
            type="button"
            {...props}
            className="inline-flex h-[30px] items-center gap-[var(--space-1)] rounded-[var(--radius-control)] border border-[var(--stroke)] px-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] transition-colors hover:border-[var(--stroke-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <span>Show: {label}</span>
            {shownCount !== undefined ? (
              <span className="tabular-nums text-[var(--ink-tertiary)]"> {shownCount}</span>
            ) : null}
            <ChevronDown aria-hidden size={14} strokeWidth={1.75} className="text-[var(--ink-tertiary)]" />
          </button>
        )}
      >
        <ViewCheck label="All" count={counts?.all} checked={draft.length === 0} onChange={() => setDraft([])} />
        {views.map((option) => (
          <ViewCheck
            key={option.id}
            label={option.label}
            count={counts?.[option.id]}
            checked={draft.includes(option.id)}
            onChange={() => toggle(option.id)}
          />
        ))}
        <Button
          size="sm"
          onClick={() => {
            onChange([...draft]);
            setOpen(false);
          }}
        >
          Apply
        </Button>
      </Popover>
      {capped && value.includes('has_activity') ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">Older activity may not show.</p>
      ) : null}
      {activityFailed ? (
        <p
          role="alert"
          className="flex w-full flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
        >
          <span>{ACTIVITY_FAILED_COPY}</span>
          {onRetryActivity ? (
            <Button variant="ghost" size="sm" onClick={onRetryActivity}>
              Try again
            </Button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

function ViewCheck({
  label,
  count,
  checked,
  onChange,
}: {
  label: string;
  count?: number;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
      <input type="checkbox" checked={checked} onChange={onChange} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
      <span className="min-w-0 flex-1">{label}</span>
      {count !== undefined ? (
        <span className="tabular-nums text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{count}</span>
      ) : null}
    </label>
  );
}

export default RailViewFilter;
