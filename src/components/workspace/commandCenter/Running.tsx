'use client';

import { motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';

import { RUNNING_LABEL, type DealRow } from '@/lib/deals/commandCenter';

import { Card, ghostButton } from './Card';

/** Running shows this many rows; the rest are one filter away in Your deals. */
export const RUNNING_LIMIT = 5;

/**
 * Activity, not progress: no run reports how far along it is, so the bar
 * never fills. A violet segment travels while a draft is in flight; under
 * prefers-reduced-motion (or before the preference is known) it holds still.
 */
function RunningActivity() {
  const reduce = useReducedMotion();
  const still = reduce !== false;
  return (
    <span
      className="relative mt-2 block h-[4px] overflow-hidden rounded-[2px] bg-[var(--ai-soft)]"
      data-testid="running-indicator"
      data-motion={still ? 'static' : 'animated'}
      aria-hidden
    >
      {still ? null : (
        <motion.span
          className="absolute inset-y-0 left-0 w-1/3 rounded-[2px] bg-[var(--ai)]"
          initial={{ x: '-100%' }}
          animate={{ x: '300%' }}
          transition={{ duration: 1.6, ease: 'easeInOut', repeat: Infinity }}
        />
      )}
    </span>
  );
}

function RunningRowView({ row }: { row: DealRow }) {
  return (
    <li data-testid="running-row">
      <Link
        href={row.href}
        className="block px-4 py-3 transition-colors duration-150 hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ink)]"
      >
        <span className="block truncate text-[length:var(--text-md)] font-medium text-[var(--ink)]">{row.stepTitle}</span>
        <span className="mt-0.5 block text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          <span className="text-[var(--ink-secondary)]">{row.codename}</span> · {row.phase}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--ai-deep)]">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--ai)]" />
          {RUNNING_LABEL}
        </span>
        <RunningActivity />
      </Link>
    </li>
  );
}

/** Renders only while at least one draft is in flight:
 *  no permanent empty card for work nothing records yet (handoff E19). */
export function Running({ rows, onShowAll }: { rows: DealRow[]; onShowAll: () => void }) {
  if (rows.length === 0) return null;
  return (
    <Card
      title="Running"
      meta={
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--ai)]" />
          {`${rows.length} running`}
        </span>
      }
    >
      <ul className="divide-y divide-[var(--stroke)]">
        {rows.slice(0, RUNNING_LIMIT).map((row) => (
          <RunningRowView key={row.dealId} row={row} />
        ))}
      </ul>
      {rows.length > RUNNING_LIMIT ? (
        <div className="border-t border-[var(--stroke)] px-4 py-2.5">
          <button type="button" className={ghostButton} onClick={onShowAll}>
            Show all {rows.length} in Your deals
          </button>
        </div>
      ) : null}
    </Card>
  );
}
