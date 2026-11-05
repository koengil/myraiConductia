'use client';

/**
 * The Book view of the Conductor Center: every deal in one table (Deal, Phase,
 * Target close, Schedule, Fee), nearest close first, schedule color-coded
 * (late = amber). The other lifecycle categories follow below in Storm's
 * order, empty ones skipped. Every cell is the deal's own data (useDeals).
 * Rendered only behind the book_view flag via BankHome.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { DealListUnavailable } from '@/components/deals/DealsUnavailable';
import { useDeals } from '@/lib/deals/useDeals';
import { formatCloseDate, formatFee, toBookRows, type BookRow } from '@/lib/book/data';
import { LIFECYCLE_CATEGORIES, LIFECYCLE_CATEGORY, LIFECYCLE_CATEGORY_LABEL } from '@/lib/constants/deals';
/* Workbench verdict grammar (kit §03): schedule health as a SOLID pastel
 * chip: ahead=positive, late=hold, on time=quiet field gray. */
const SCHEDULE_STYLE: Record<string, { label: string; chipClass: string }> = {
  on_time: { label: 'On time', chipClass: 'bg-[var(--surface-subtle)] text-[var(--ink-secondary)]' },
  ahead: { label: 'Ahead', chipClass: 'bg-[var(--positive-fill)] text-[var(--positive-deep)]' },
  late: { label: 'Late', chipClass: 'bg-[var(--hold-fill)] text-[var(--hold-deep)]' },
};

/** A stacked cell's own small label below sm, where the header row is hidden.
 *  Drawn from data-label as generated content, so a cell's text stays its
 *  value alone (the e2e book steps read cell text). */
const CELL_LABEL =
  'max-sm:before:mb-0.5 max-sm:before:block max-sm:before:font-sans max-sm:before:text-[11px] max-sm:before:font-normal max-sm:before:text-[var(--ink-tertiary)] max-sm:before:content-[attr(data-label)]';

/** Below sm the table reflows into stacked rows; explicit ARIA roles keep the
 *  table semantics that `display: block/grid` would strip (as DealsTable). */
const TABLE_STACK = 'max-sm:block';
const WRAPPER =
  'rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-6 max-sm:px-4 sm:overflow-x-auto';

function DealRow({ row }: { row: BookRow }) {
  const router = useRouter();
  const schedule = row.scheduleStatus ? SCHEDULE_STYLE[row.scheduleStatus] : null;
  return (
    // The WHOLE row navigates (mouse); the name stays a real link so
    // keyboard and screen-reader users keep a first-class target.
    <tr
      onClick={(e) => {
        // The name's own <Link> already handled its click (modifier keys,
        // new tabs); a modified click or a drag-select on another cell must
        // not hijack the tab.
        if (e.defaultPrevented || (e.target as HTMLElement).closest('a')) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (window.getSelection()?.toString()) return;
        router.push(`/projects/${row.id}/book`);
      }}
      role="row"
      className="cursor-pointer border-t border-[var(--stroke)] transition-colors duration-150 hover:bg-[var(--surface-raised)] max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-4 max-sm:gap-y-2 max-sm:py-3"
    >
      <td role="cell" className="py-4 pr-6 max-sm:col-span-2 max-sm:p-0">
        {/* In Book mode a deal opens its Book drill-down (slice 2); the
            Console keeps routing to the rail untouched. */}
        <Link
          href={`/projects/${row.id}/book`}
          className="rounded-[var(--radius-control)] font-medium text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
        >
          {row.codename}
        </Link>
      </td>
      <td role="cell" data-label="Phase" className={`py-4 pr-6 text-[var(--ink-secondary)] max-sm:col-span-2 max-sm:p-0 ${CELL_LABEL}`}>
        {row.stage}
      </td>
      <td
        role="cell"
        data-label="Target close"
        className={`py-4 pr-6 font-mono text-[length:var(--text-sm)] tabular-nums text-[var(--ink-secondary)] max-sm:p-0 ${CELL_LABEL}`}
      >
        {row.closeDate ? formatCloseDate(row.closeDate) : 'Not set'}
      </td>
      <td role="cell" data-label="Schedule" className={`py-4 pr-6 max-sm:p-0 ${CELL_LABEL}`}>
        {schedule ? (
          <span
            className={`inline-flex items-center rounded-[6px] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-xs)] font-medium leading-none ${schedule.chipClass}`}
          >
            {schedule.label}
          </span>
        ) : (
          <span className="text-[var(--ink-tertiary)]">Not set</span>
        )}
      </td>
      {/* The fee wraps and, below sm, stacks with its own label: it never
          clips and the table never scrolls sideways. */}
      <td
        role="cell"
        data-label="Fee"
        className={`break-words py-4 text-right font-mono text-[length:var(--text-sm)] font-medium tabular-nums text-[var(--ink)] max-sm:p-0 max-sm:text-left ${CELL_LABEL}`}
      >
        {row.feeUsd != null ? formatFee(row.feeUsd) : 'Not set'}
      </td>
    </tr>
  );
}

export function BookHome() {
  const { state, deals, reload } = useDeals();
  const loading = state.status === 'loading';
  const failed = state.status === 'error';
  const rows = toBookRows(deals);
  const live = rows.filter((r) => r.category === LIFECYCLE_CATEGORY.LIVE);
  // Every other category, in Storm's order; empty groups are not rendered.
  // A row outside the seven (unreachable while the DB CHECK holds) still
  // renders, under its own heading: "every deal in the book" must stay true.
  const known = new Set<string>(LIFECYCLE_CATEGORIES);
  const groups = [
    ...LIFECYCLE_CATEGORIES.filter((c) => c !== LIFECYCLE_CATEGORY.LIVE).map((c) => ({
      key: c as string,
      label: LIFECYCLE_CATEGORY_LABEL[c],
      rows: rows.filter((r) => r.category === c),
    })),
    { key: 'other', label: 'Uncategorized', rows: rows.filter((r) => !known.has(r.category)) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <div className="mx-auto max-w-[1080px] px-6 py-10">
        <p className="eyebrow mb-1">Conductor Center</p>
        {/* Page heading is interface voice, not deal identity: Inter sans 600
            (kit §01: serif is identity-only). */}
        <h1 className="mb-8 text-[24px] font-semibold leading-tight tracking-[-0.012em] text-[var(--ink)]">
          Your book
        </h1>

        {/* Live Deals table */}
          <section>
            <h2 id="book-group-live" className="display-1 mb-3 text-[var(--ink)]">
              {LIFECYCLE_CATEGORY_LABEL.live}
            </h2>
            <div className={WRAPPER}>
              <table
                role="table"
                aria-labelledby="book-group-live"
                className={`w-full text-left text-[length:var(--text-base)] ${TABLE_STACK}`}
              >
                <thead role="rowgroup" className="max-sm:sr-only">
                  {/* Kit §05: gray 12px sans headers, no caps, no tracking. */}
                  <tr role="row" className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
                    <th role="columnheader" className="py-3.5 pr-6 font-medium">Deal</th>
                    <th role="columnheader" className="py-3.5 pr-6 font-medium">Phase</th>
                    <th role="columnheader" className="py-3.5 pr-6 font-medium">Target close</th>
                    <th role="columnheader" className="py-3.5 pr-6 font-medium">Schedule</th>
                    <th role="columnheader" className="py-3.5 text-right font-medium">Fee</th>
                  </tr>
                </thead>
                <tbody role="rowgroup" className={TABLE_STACK}>
                  {live.map((row) => (
                    <DealRow key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
              {/* While the list is in flight the book is NOT empty — a false
                  'no deals' reads as a broken page. (BookDeal early-returns
                  its whole page; here each pane gets its own quiet state.) */}
              {/* A failed list is not an empty book either (#162). */}
              {failed ? (
                <DealListUnavailable onRetry={reload} />
              ) : live.length === 0 ? (
                <p className="py-6 text-[length:var(--text-base)] text-[var(--ink-tertiary)]">
                  {loading ? 'Loading the book…' : 'No live deals yet.'}
                </p>
              ) : null}
            </div>

            {failed ? null : groups.map((group) => (
              <React.Fragment key={group.key}>
                <h2 id={`book-group-${group.key}`} className="display-1 mt-6 mb-3 text-[var(--ink)]">
                  {group.label}
                </h2>
                <div className={WRAPPER}>
                  <table
                    role="table"
                    aria-labelledby={`book-group-${group.key}`}
                    className={`w-full text-left text-[length:var(--text-base)] ${TABLE_STACK}`}
                  >
                    <tbody role="rowgroup" className={TABLE_STACK}>
                      {group.rows.map((row) => (
                        <DealRow key={row.id} row={row} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </React.Fragment>
            ))}
        </section>
      </div>
    </div>
  );
}
