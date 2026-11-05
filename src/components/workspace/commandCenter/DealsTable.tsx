import Link from 'next/link';
import type * as React from 'react';

import { AvatarInitials } from '@/components/atoms/AvatarInitials';
import { UNASSIGNED_LABEL, type DealRow } from '@/lib/deals/commandCenter';
import { formatDate } from '@/lib/format/date';

import { PhaseMeter } from './PhaseMeter';

export type SortKey = 'progress' | 'close' | 'needs' | 'name';

const CATEGORY_CHIP: Partial<Record<DealRow['category'], string>> = {
  pitch: 'Pitch',
  prospect: 'Prospect',
  mandate_hold: 'Mandate hold',
  terminated: 'Terminated',
  closed: 'Closed',
  lost: 'Lost',
};

const ARIA_SORT_COLUMN: Record<SortKey, string> = {
  name: 'deal',
  progress: 'phase',
  close: 'close',
  needs: 'needs',
};

/** Progress and needs sort high to low; name and close sort low to high. */
function ariaSort(sort: SortKey, column: string): React.AriaAttributes['aria-sort'] {
  if (ARIA_SORT_COLUMN[sort] !== column) return undefined;
  return sort === 'progress' || sort === 'needs' ? 'descending' : 'ascending';
}

function initialsOf(name: string): string {
  const parts = name.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '')).toUpperCase();
}

/** Who is on the current step: the assignee by name, else "Unassigned". */
function OnIt({ row }: { row: DealRow }) {
  if (!row.hasCurrentStep) return <span className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">No one</span>;
  if (row.assigneeName) {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-[length:var(--text-sm)] text-[var(--ink)]">
        <AvatarInitials initials={initialsOf(row.assigneeName)} className="h-6! w-6! text-[length:var(--text-xxs)]" />
        <span className="truncate">{row.assigneeName}</span>
      </span>
    );
  }
  return <span className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">{UNASSIGNED_LABEL}</span>;
}

/**
 * One row per deal. Below md the table reflows into stacked rows; explicit
 * ARIA roles keep the table semantics that `display: block/grid` would strip,
 * and each cell carries its own small label for sighted readers.
 */
export function DealsTable({
  rows,
  sort,
  needsKnown = true,
}: {
  rows: DealRow[];
  sort: SortKey;
  /** False while the needs-you count is unknown: the cell stays empty. */
  needsKnown?: boolean;
}) {
  const th = 'px-4 py-2.5 text-left text-[length:var(--text-xs)] font-medium text-[var(--ink-tertiary)]';
  const cellLabel = 'mb-0.5 block text-[length:var(--text-xs)] text-[var(--ink-tertiary)] md:hidden';
  return (
    <table role="table" aria-label="Your deals" className="w-full border-collapse max-md:block">
      <thead role="rowgroup" className="max-md:sr-only">
        <tr role="row" className="border-b border-[var(--stroke)] bg-[var(--surface-warm)]">
          <th role="columnheader" scope="col" className={th} aria-sort={ariaSort(sort, 'deal')}>Deal</th>
          <th role="columnheader" scope="col" className={th} aria-sort={ariaSort(sort, 'phase')}>Phase</th>
          <th role="columnheader" scope="col" className={th}>Current step</th>
          <th role="columnheader" scope="col" className={th}>On it</th>
          <th role="columnheader" scope="col" className={th} aria-sort={ariaSort(sort, 'close')}>Target close</th>
          <th role="columnheader" scope="col" className={`${th} text-right`} aria-sort={ariaSort(sort, 'needs')}>Needs you</th>
        </tr>
      </thead>
      <tbody role="rowgroup" className="max-md:block">
        {rows.map((row) => {
          const close = row.targetCloseDate ? formatDate(row.targetCloseDate, { timeZone: 'UTC' }) : 'Not set';
          const chip = CATEGORY_CHIP[row.category];
          return (
            <tr
              role="row"
              key={row.dealId}
              data-testid="deal-row"
              data-deal={row.codename}
              className="border-b border-[var(--stroke)] last:border-b-0 max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-3 max-md:px-4 max-md:py-3.5"
            >
              <td role="cell" className="px-4 py-3 align-top max-md:col-span-2 max-md:p-0">
                {/* A long codename wraps rather than clipping. */}
                <Link
                  href={`/projects/${row.code || row.dealId}`}
                  className="min-w-0 break-words font-display text-[length:var(--text-md)] text-[var(--ink)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
                >
                  {row.codename}
                </Link>
                {chip ? (
                  <span className="ml-2 rounded-[6px] bg-[var(--surface-subtle)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-xs)] font-medium leading-none text-[var(--ink-secondary)]">
                    {chip}
                  </span>
                ) : null}
              </td>
              <td role="cell" className="px-4 py-3 align-top max-md:col-span-2 max-md:p-0">
                <span className={cellLabel}>Phase</span>
                <PhaseMeter row={row} />
                <span className="mt-1.5 block text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  {row.phase}
                  {row.phasePercent != null ? (
                    <span className="font-mono tabular-nums text-[var(--ink-tertiary)]"> · {row.phasePercent}% done</span>
                  ) : null}
                </span>
              </td>
              <td role="cell" className="max-w-[260px] px-4 py-3 align-top max-md:col-span-2 max-md:max-w-none max-md:p-0">
                <span className={cellLabel}>Current step</span>
                {row.hasCurrentStep ? (
                  <Link
                    href={row.href}
                    aria-label={`Open ${row.codename}: ${row.stepTitle}`}
                    className="line-clamp-2 text-[length:var(--text-sm)] text-[var(--ink)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
                  >
                    {row.stepTitle}
                  </Link>
                ) : (
                  <span className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">{row.stepTitle}</span>
                )}
              </td>
              <td role="cell" className="px-4 py-3 align-top max-md:p-0">
                <span className={cellLabel}>On it</span>
                <OnIt row={row} />
              </td>
              <td role="cell" className="whitespace-nowrap px-4 py-3 align-top text-[length:var(--text-sm)] max-md:p-0">
                <span className={cellLabel}>Target close</span>
                <span className={row.targetCloseDate ? 'text-[var(--ink)]' : 'text-[var(--ink-tertiary)]'}>{close}</span>
              </td>
              <td
                role="cell"
                className="px-4 py-3 text-right align-top max-md:col-span-2 max-md:flex max-md:items-baseline max-md:justify-between max-md:p-0 max-md:text-left"
              >
                <span className={cellLabel} aria-hidden>
                  Needs you
                </span>
                <span
                  data-testid="needs-you-count"
                  className={`font-mono text-[length:var(--text-sm)] tabular-nums ${
                    row.needsYou > 0 ? 'font-semibold text-[var(--ink)]' : 'text-[var(--ink-tertiary)]'
                  }`}
                >
                  {needsKnown ? (
                    <>
                      {row.needsYou}
                      <span className="sr-only">{row.needsYou === 1 ? ' item needs you' : ' items need you'}</span>
                    </>
                  ) : null}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
