'use client';

import * as React from 'react';

import { getApi } from '@/lib/api';
import type {
  FootballFieldRow,
  Valuation,
  ValuationTrace,
} from '@/lib/api/types';
import { Card } from '@/components/atoms';
import { useProjectId } from '@/lib/project/useProjectId';
import { resolveDeal } from '@/lib/rail/deals';

/**
 * Football Field — valuation envelope panel for the `/acquirers/[id]`
 * deep-dive (Phase D of the sandbox merge, 2026-05-20). Ported from
 * `intelibank-sandbox/components/scenes/FootballField.tsx`; the renderer is
 * now data-driven from the typed seam (`getValuation`) instead of inline
 * literals, and the prose is sanitised per §4 of the front-end overhaul
 * ledger (no em-dashes in visible copy; en-dashes are preserved only for
 * numerical ranges like `$10.4B–$30B`).
 *
 * Self-fetching: mounts, calls `getApi().getValuation()` once, and manages a
 * `loading | ready | error` state with the same unmount-safe `active` flag
 * pattern the `/acquirers/[id]` route uses. On reject we surface a quiet
 * one-liner and log a single diagnostic — no thrown errors, no spinner
 * spam — because this panel sits inside the workspace stage and must
 * degrade gracefully.
 *
 * Three regions:
 *   1. Eyebrow + display-1 title — "Valuation envelope" / "Football field".
 *   2. Vertical list of rows. Each row is `name | bar | value + note`. The
 *      bar is a 0–1 normalised horizontal range; `needsData` rows render
 *      the literal `// NEEDS-DATA` marker in mono instead of a bar so the
 *      MD can see what's grounded vs what's a placeholder (CLAUDE.md
 *      thesis — "flag gaps, do not fabricate").
 *   3. Trace footer — three inline mono labels showing the figures the
 *      envelope is grounded in (revenue, gross margin, last-quarter
 *      growth).
 */

type LoadState = 'loading' | 'ready' | 'error';

// Series hues (kit §10): ink for the primary series, signal hues via status
// tokens, quiet gray for neutral bands. No violet — this is an analysis
// output, not a live Casey run.
const TONE_BG: Record<NonNullable<FootballFieldRow['tone']>, string> = {
  positive: 'var(--positive)',
  accent: 'var(--ink)',
  neutral: 'var(--ink-quiet)',
};

function rangeBackground(tone: FootballFieldRow['tone']): string {
  return TONE_BG[tone ?? 'neutral'];
}

function FFRow({ row }: { row: FootballFieldRow }) {
  const hasBar =
    typeof row.rangeStart === 'number' && typeof row.rangeEnd === 'number';

  return (
    <div className="grid grid-cols-1 items-center gap-[var(--space-3)] lg:grid-cols-[180px_minmax(0,1fr)_auto]">
      <div className="font-sans text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
        {row.name}
      </div>

      <div className="relative h-[10px] w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--surface-subtle)]">
        {hasBar ? (
          <div
            className="absolute top-0 bottom-0 rounded-[var(--radius-pill)]"
            style={{
              left: `${(row.rangeStart as number) * 100}%`,
              right: `${(1 - (row.rangeEnd as number)) * 100}%`,
              background: rangeBackground(row.tone),
            }}
            role="meter"
            aria-label={`${row.name} range`}
            aria-valuenow={Math.round(
              (((row.rangeStart as number) + (row.rangeEnd as number)) / 2) *
                100,
            )}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        ) : row.needsData ? (
          <div className="absolute inset-0 flex items-center px-[var(--space-2)] font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {'// NEEDS-DATA'}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col items-start gap-[var(--space-1)] lg:items-end lg:text-right">
        <div className="font-sans text-[length:var(--text-lg)] font-semibold text-[var(--ink)] tabular-nums">
          {row.value}
        </div>
        <div className="max-w-[36ch] font-sans text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {row.note}
        </div>
      </div>
    </div>
  );
}

function TraceFooter({ trace }: { trace: ValuationTrace }) {
  return (
    <div className="flex flex-col gap-[var(--space-1)] border-t border-[var(--stroke)] pt-[var(--space-4)]">
      <span className="eyebrow">Trace</span>
      <div className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        <span>Revenue TTM </span>
        <span className="text-[var(--ink)]">{trace.revenueLabel}</span>
        <span> · Gross margin </span>
        <span className="text-[var(--ink)]">{trace.grossMarginPct}%</span>
        <span> · Last-qtr growth </span>
        <span className="text-[var(--ink)]">
          {trace.lastQtrGrowthPct >= 0 ? '+' : ''}
          {trace.lastQtrGrowthPct}%
        </span>
      </div>
    </div>
  );
}

export function FootballFieldPanel() {
  const [valuation, setValuation] = React.useState<Valuation | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');
  // COMPLIANCE: reference the deal by CODE NAME, never the target company.
  const dealId = useProjectId();
  const codename = resolveDeal(dealId)?.codename ?? dealId;

  React.useEffect(() => {
    let active = true;
    const api = getApi();

    async function load() {
      try {
        const v = await api.getValuation(dealId);
        if (!active) return;
        setValuation(v);
        setLoadState('ready');
      } catch (err) {
        if (!active) return;
        console.error(
          '[FootballFieldPanel] failed to load valuation',
          { err },
        );
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [dealId]);

  return (
    <Card aria-label="Football field valuation envelope">
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">
          Valuation envelope
        </span>
        <h3 className="display-1 text-[var(--ink)]">Football field</h3>
        <p className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {codename}&rsquo;s value range, every method side by side.
        </p>
      </div>

      {loadState === 'loading' ? (
        <p
          className="mt-[var(--space-6)] font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          aria-live="polite"
        >
          Loading the valuation envelope…
        </p>
      ) : null}

      {loadState === 'error' ? (
        <p
          role="status"
          className="mt-[var(--space-6)] font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          The valuation envelope could not be loaded right now.
        </p>
      ) : null}

      {loadState === 'ready' && valuation ? (
        <>
          <div className="mt-[var(--space-6)] flex flex-col gap-[var(--space-5)]">
            {valuation.rows.map((row) => (
              <FFRow key={row.name} row={row} />
            ))}
          </div>

          {/* Verdict — the read an MD takes from this field. Grounded in
              docs/06-research/atlassian-may-2026-financials.md: a ~55% drop
              over the year then a ~30% single-session rally leaves a wide
              value band, so the entry price is contested, not settled. */}
          <p className="mt-[var(--space-6)] max-w-[62ch] font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
            <span className="font-semibold text-[var(--ink)]">
              Read:
            </span>{' '}
            the band is wide on purpose. A roughly 55% drawdown over the year,
            then a 30% single-session rally on a beat, leaves trading well off
            both extremes. Entry price is contested, not settled. DCF and a
            real comp set still need wiring before the floor is defensible.
          </p>

          <div className="mt-[var(--space-6)]">
            <TraceFooter trace={valuation.trace} />
          </div>
        </>
      ) : null}
    </Card>
  );
}

export default FootballFieldPanel;
