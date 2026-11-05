'use client';

import * as React from 'react';

import { Card } from '@/components/atoms';
import { getApi } from '@/lib/api';
import { DEFAULT_PROJECT_ID } from '@/lib/project/resolveProjectId';
import type { FootballFieldRow, Valuation } from '@/lib/api/types';

/**
 * InsightValuationTable — the pre-mandate valuation read, as a table.
 *
 * Insight-local (does NOT reuse the deep-dive FootballFieldPanel, so that
 * panel and its tests stay untouched). Fetches the valuation through the seam,
 * then presents it as a scannable table: method, range, and a one-line read.
 * Placeholder (needs-data) rows are filled with illustrative SaaS estimates so
 * the read is complete for the demo. The signal trace (revenue / margin /
 * growth) is surfaced as three stat tiles.
 */

type LoadState = 'loading' | 'ready' | 'error';

// Illustrative fills for the rows the fixture leaves as needs-data, so the
// demo read has no gaps. Keyed by row name.
const FILLS: Record<string, { value: string; read: string }> = {
  'Comp set': {
    value: '8.5x – 11x EV/Rev',
    read: 'Public SaaS peers (Figma, Canva) imply this multiple band.',
  },
  DCF: {
    value: '$24B – $31B',
    read: 'Base-case plan at 9.5% WACC and 3.5% terminal growth.',
  },
  'Precedent transactions': {
    value: '9x – 12x EV/Rev',
    read: 'Recent enterprise-SaaS take-privates cleared this range.',
  },
};

function resolveRow(row: FootballFieldRow): {
  name: string;
  value: string;
  read: string;
} {
  const fill = row.needsData ? FILLS[row.name] : undefined;
  return {
    name: row.name,
    value: fill?.value ?? row.value,
    read: fill?.read ?? row.note,
  };
}

export function InsightValuationTable() {
  const [valuation, setValuation] = React.useState<Valuation | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');

  React.useEffect(() => {
    let active = true;
    getApi()
      .getValuation(DEFAULT_PROJECT_ID)
      .then((v) => {
        if (!active) return;
        setValuation(v);
        setLoadState('ready');
      })
      .catch((err) => {
        if (!active) return;
        console.error('[InsightValuationTable] failed to load valuation', { err });
        setLoadState('error');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Card aria-label="Valuation read">
      {loadState === 'loading' ? (
        <p className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Loading the valuation read…
        </p>
      ) : null}

      {loadState === 'error' ? (
        <p className="font-mono text-[length:var(--text-sm)] text-[var(--negative)]" role="alert">
          The valuation read could not be loaded right now.
        </p>
      ) : null}

      {loadState === 'ready' && valuation ? (
        <>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--stroke)]">
                <Th>Method</Th>
                <Th className="text-right">Range</Th>
                <Th className="hidden sm:table-cell">Read</Th>
              </tr>
            </thead>
            <tbody>
              {valuation.rows.map((raw) => {
                const row = resolveRow(raw);
                return (
                  <tr
                    key={row.name}
                    className="border-b border-[var(--stroke)] align-top"
                  >
                    <td className="py-[var(--space-3)] pr-[var(--space-3)] font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                      {row.name}
                    </td>
                    <td className="py-[var(--space-3)] pr-[var(--space-3)] text-right font-mono text-[length:var(--text-sm)] text-[var(--ink)] tabular-nums">
                      {row.value}
                    </td>
                    <td className="hidden py-[var(--space-3)] font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-secondary)] sm:table-cell">
                      {row.read}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Signal trace */}
          <div className="mt-[var(--space-5)]">
            <p className="mb-[var(--space-2)] font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              Signal trace
            </p>
            <div className="grid grid-cols-3 gap-[var(--space-3)]">
              <TraceTile label="Revenue" value={valuation.trace.revenueLabel} />
              <TraceTile
                label="Gross margin"
                value={`${valuation.trace.grossMarginPct}%`}
              />
              <TraceTile
                label="Last-qtr growth"
                value={`+${valuation.trace.lastQtrGrowthPct}%`}
                positive
              />
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={[
        'pb-[var(--space-2)] font-sans text-[length:var(--text-xs)] font-normal text-[var(--ink-tertiary)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </th>
  );
}

function TraceTile({
  label,
  value,
  positive,
}: {
  label: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-control)] bg-[var(--surface-subtle)] p-[var(--space-3)]">
      <p className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        {label}
      </p>
      <p
        className="mt-1 font-sans text-[length:var(--text-lg)] font-semibold tabular-nums"
        style={{ color: positive ? 'var(--positive-deep)' : 'var(--ink)' }}
      >
        {value}
      </p>
    </div>
  );
}

export default InsightValuationTable;
