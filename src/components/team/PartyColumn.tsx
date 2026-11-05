'use client';

import * as React from 'react';

/**
 * One party's column on the Team perimeter: a white card carrying the party
 * heading, an optional boundary meta line, a seat count, and hairline-divided
 * rows. Shared by the fixture roster (one column per side) and the live roster
 * (one column per firm) so the perimeter reads the same on both.
 */

/** The column track for a party grid. Defined once, used by both rosters. */
export const PARTY_COLUMN_GRID =
  'grid items-start gap-[var(--space-4)] [grid-template-columns:repeat(auto-fit,minmax(17rem,1fr))]';

export type PartyColumnProps = {
  /** Accessible name for the column. */
  label: string;
  /** Visible heading, when it carries more than the label (an icon, say). */
  heading?: React.ReactNode;
  /** Boundary line under the heading (a party-role pill, say). */
  meta?: React.ReactNode;
  /** People in this column. Announced beside the heading. */
  count?: number;
  /** Heading level: 3 when the column sits under a page group heading. Default 2. */
  headingLevel?: 2 | 3;
  children: React.ReactNode;
};

export function PartyColumn({ label, heading, meta, count, headingLevel = 2, children }: PartyColumnProps) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]"
    >
      <header className="flex flex-col gap-[var(--space-1)] border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
        <div className="flex items-baseline justify-between gap-[var(--space-2)]">
          <Heading className="eyebrow">{heading ?? label}</Heading>
          {typeof count === 'number' ? (
            <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
              <span className="sr-only">{count === 1 ? '1 person' : `${count} people`}</span>
              <span aria-hidden="true">{count}</span>
            </span>
          ) : null}
        </div>
        {meta}
      </header>
      <ul className="m-0 flex list-none flex-col divide-y divide-[var(--stroke)] p-0">
        {children}
      </ul>
    </section>
  );
}

export default PartyColumn;
