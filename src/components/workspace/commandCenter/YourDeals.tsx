'use client';

import * as React from 'react';

import { Menu } from '@/components/overlay';
import type { DealRow } from '@/lib/deals/commandCenter';
import { MVP_DEAL_RAIL } from '@/lib/rail/dealRail';

import { Card, Empty, ghostButton, plural } from './Card';
import { DealsTable, type SortKey } from './DealsTable';

/** Sort and filter controls appear once the list is long enough to need them. */
export const DEAL_TOOLS_AT = 6;

const SORT_LABEL: Record<SortKey, string> = {
  progress: 'Furthest along',
  close: 'Target close',
  needs: 'Needs you',
  name: 'Name',
};

export type ShowKey = 'all' | 'running' | 'needs';
const SHOW_LABEL: Record<ShowKey, string> = {
  all: 'All deals',
  running: 'Running',
  needs: 'Needs you',
};

function matchesShow(row: DealRow, show: ShowKey): boolean {
  switch (show) {
    case 'running':
      return row.running;
    case 'needs':
      return row.needsYou > 0;
    case 'all':
      return true;
  }
}

function compareRows(sort: SortKey) {
  return (a: DealRow, b: DealRow): number => {
    switch (sort) {
      case 'close': {
        const ac = a.targetCloseDate ?? '9999-12-31';
        const bc = b.targetCloseDate ?? '9999-12-31';
        return ac.localeCompare(bc) || a.codename.localeCompare(b.codename);
      }
      case 'needs':
        return b.needsYou - a.needsYou || b.progressKey - a.progressKey || a.codename.localeCompare(b.codename);
      case 'name':
        return a.codename.localeCompare(b.codename);
      case 'progress':
      default:
        return b.progressKey - a.progressKey || a.codename.localeCompare(b.codename);
    }
  };
}

export function YourDeals({
  rows,
  show,
  setShow,
  needsKnown = true,
}: {
  rows: DealRow[];
  show: ShowKey;
  setShow: (next: ShowKey) => void;
  /** False until the notifications read lands, or when it failed: the
   *  Needs-you cells and filter then say nothing rather than a false 0. */
  needsKnown?: boolean;
}) {
  const [sort, setSort] = React.useState<SortKey>('progress');
  const [phase, setPhase] = React.useState<number | 'all'>('all');
  const [query, setQuery] = React.useState('');
  const tools = rows.length >= DEAL_TOOLS_AT;
  // "Running" is offered only while something runs.
  const anyRunning = rows.some((r) => r.running);
  const showKeys = (Object.keys(SHOW_LABEL) as ShowKey[]).filter(
    (key) => (key !== 'running' || anyRunning) && (key !== 'needs' || needsKnown),
  );
  const shown: ShowKey = showKeys.includes(show) ? show : 'all';

  const needle = query.trim().toLowerCase();
  const visible = rows
    .filter((r) => matchesShow(r, shown))
    .filter((r) => phase === 'all' || r.phaseIndex === phase)
    .filter((r) => !needle || r.codename.toLowerCase().includes(needle) || r.code.toLowerCase().includes(needle))
    .sort(compareRows(sort));
  const filtered = shown !== 'all' || phase !== 'all' || needle !== '';

  const picker = 'h-[30px] px-2.5 gap-1';
  return (
    <Card
      id="your-deals"
      title="Your deals"
      meta={
        <span className="font-mono tabular-nums">
          {filtered ? `${visible.length} of ${plural(rows.length, 'deal')}` : plural(rows.length, 'deal')}
        </span>
      }
    >
      {tools ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--stroke)] px-4 py-2.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find a deal"
            placeholder="Find a deal"
            className="h-[30px] w-full rounded-[var(--radius-control)] bg-[var(--surface-subtle)] px-3 text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:w-[200px]"
          />
          <Menu
            label="Show"
            align="start"
            triggerClassName={picker}
            trigger={SHOW_LABEL[shown]}
            items={showKeys.map((key) => ({
              id: key,
              label: SHOW_LABEL[key],
              checked: shown === key,
              onSelect: () => setShow(key),
            }))}
          />
          <Menu
            label="Phase"
            align="start"
            triggerClassName={picker}
            trigger={MVP_DEAL_RAIL.find((p) => p.index === phase)?.name ?? 'All phases'}
            items={[
              { id: 'all', label: 'All phases', checked: phase === 'all', onSelect: () => setPhase('all') },
              ...MVP_DEAL_RAIL.map((p) => ({
                id: String(p.index),
                label: p.name,
                checked: phase === p.index,
                onSelect: () => setPhase(p.index),
              })),
            ]}
          />
          <Menu
            label="Sort by"
            align="start"
            triggerClassName={`${picker} sm:ml-auto`}
            trigger={SORT_LABEL[sort]}
            items={(Object.keys(SORT_LABEL) as SortKey[]).map((key) => ({
              id: key,
              label: SORT_LABEL[key],
              checked: sort === key,
              onSelect: () => setSort(key),
            }))}
          />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Empty>No live deals yet.</Empty>
      ) : visible.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <p className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">No deals match.</p>
          <button
            type="button"
            className={ghostButton}
            onClick={() => {
              setShow('all');
              setPhase('all');
              setQuery('');
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <DealsTable rows={visible} sort={sort} needsKnown={needsKnown} />
      )}
    </Card>
  );
}
