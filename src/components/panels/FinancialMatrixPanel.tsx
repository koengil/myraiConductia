'use client';

import * as React from 'react';

import type { Company } from '@/lib/api/types';
import { Card } from '@/components/atoms';

export type FinancialMatrixPanelProps = {
  company: Company;
};

/**
 * Financial matrix panel — experience-spine Step 4 (a panel rendered on the
 * hero canvas after a skill is dropped). Surfaces the seven `Financials`
 * figures as a medium-dense tile grid (visual-language.md "Spacing and
 * density"). Decisions, not a data dump: each figure is one labelled tile,
 * ex-banker-credible — figures set in the interface sans (Inter),
 * formatted for an MD to read at a glance.
 *
 * Pure presentational: every figure comes from `company.financials`. No data
 * fetching, no scoring, no session.
 */

// Human-readable USD: $34.9B / $700.0M / $12.4K / $480. One decimal place at
// the B / M / K scale (the asserted `$700.0M` formatting is byte-stable).
function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : '';
  const n = Math.abs(value);
  if (n >= 1_000_000_000) return `${sign}$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${sign}$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${sign}$${(n / 1_000).toFixed(1)}K`;
  return `${sign}$${n.toLocaleString('en-US')}`;
}

// Signed percentage: +18.0% / -4.2%. Margins read without a forced + sign
// only on the explicit growth metric; both use one decimal for consistency.
function formatPct(value: number, { signed }: { signed: boolean }): string {
  const fixed = value.toFixed(1);
  if (signed && value > 0) return `+${fixed}%`;
  return `${fixed}%`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

type Tile = { label: string; value: string };

export function FinancialMatrixPanel({ company }: FinancialMatrixPanelProps) {
  const f = company.financials;

  const tiles: Tile[] = [
    { label: 'Valuation', value: formatUsd(f.valuationUsd) },
    { label: 'Revenue', value: formatUsd(f.revenueUsd) },
    {
      label: 'Revenue growth',
      value: formatPct(f.revenueGrowthPct, { signed: true }),
    },
    { label: 'EBITDA', value: formatUsd(f.ebitdaUsd) },
    {
      label: 'EBITDA margin',
      value: formatPct(f.ebitdaMarginPct, { signed: false }),
    },
    { label: 'Cash', value: formatUsd(f.cashUsd) },
    { label: 'Headcount', value: formatCount(f.headcount) },
  ];

  return (
    <Card aria-label={`Financial matrix, ${company.name}`}>
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">
          Financial matrix
        </span>
        <h3 className="font-sans text-[length:var(--text-xl)] font-semibold leading-tight text-[var(--ink)]">
          {company.name}
        </h3>
      </div>

      <dl className="mt-[var(--space-8)] grid grid-cols-2 gap-[var(--space-3)] sm:grid-cols-3">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className={
              'flex flex-col gap-[var(--space-2)] ' +
              'rounded-[var(--radius-card)] bg-[var(--surface-subtle)] ' +
              'p-[var(--space-4)]'
            }
          >
            <dt className="font-sans text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
              {tile.label}
            </dt>
            <dd
              className="font-sans text-[length:var(--text-2xl)] font-semibold leading-none text-[var(--ink)]"
              style={{ fontFeatureSettings: '"tnum" 1, "lnum" 1' }}
            >
              {tile.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default FinancialMatrixPanel;
