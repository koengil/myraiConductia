'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';
import type { SpendLine, SpendSummary } from '@/lib/ai/spend';

/**
 * AI spend from the authorized ledger API: per deal beside its compliance
 * record (Issue #109), or firm-wide on the AI Costs page (Issue #155) when no
 * dealId is given, where it opens expanded.
 * The total sits in the disclosure summary, with deal/person/task/model cuts.
 * A deal with no AI call yet renders the empty line and nothing else: the
 * panel never invents a number. A refused read (the route's 401/403, or for
 * a deal its 404: a fixture deal, or one the viewer is not on) hides the
 * panel. A failed read (5xx, network) keeps the panel with a plain line and
 * Try again, never a silent gap.
 */
type Payload = {
  summary: SpendSummary;
  window?: { truncated: boolean; limit: number };
};

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatUsd(n: number): string {
  return USD.format(n);
}

export function AiSpendPanel({ dealId, expanded = false }: { dealId?: string; expanded?: boolean }) {
  // Agrees with the route, which treats an empty dealId as the firm-wide scope.
  const firmWide = !dealId;
  const endpoint = firmWide ? '/api/v1/ai-spend' : `/api/v1/ai-spend?dealId=${encodeURIComponent(dealId)}`;
  // Keyed by endpoint so a scope switch reads as loading without a synchronous
  // reset inside the effect.
  const [state, setState] = React.useState<
    | { endpoint: string; status: 'ready'; summary: SpendSummary; truncatedAt: number | null }
    | { endpoint: string; status: 'unavailable'; refused: boolean }
    | null
  >(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(endpoint, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          const refused =
            res.status === 401 || res.status === 403 || (!firmWide && res.status === 404);
          if (!cancelled) setState({ endpoint, status: 'unavailable', refused });
          return;
        }
        const body = (await res.json()) as Payload;
        if (!cancelled) {
          setState({
            endpoint,
            status: 'ready',
            summary: body.summary,
            truncatedAt: body.window?.truncated ? body.window.limit : null,
          });
        }
      } catch {
        if (!cancelled) setState({ endpoint, status: 'unavailable', refused: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, firmWide, attempt]);

  const current = state?.endpoint === endpoint ? state : null;
  if (current?.status === 'unavailable' && current.refused) return null;
  if (current?.status === 'unavailable') {
    return (
      <section
        aria-label={firmWide ? 'Firm AI spend' : 'AI spend'}
        className="mt-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]"
      >
        <span className="bank-label">{firmWide ? 'Firm AI spend' : 'AI spend'}</span>
        <p role="alert" className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          AI spend could not be loaded.
        </p>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setState(null);
            setAttempt((n) => n + 1);
          }}
        >
          {TRY_AGAIN_COPY}
        </Button>
      </section>
    );
  }

  const summary = current?.status === 'ready' ? current.summary : null;
  const headline =
    !current
      ? 'Loading AI spend…'
      : summary && summary.calls > 0
        ? `${formatUsd(summary.totalCostUsd)} across ${
            current?.status === 'ready' && current.truncatedAt ? `the latest ${current.truncatedAt}` : summary.calls
          } API call${summary.calls === 1 ? '' : 's'}${
            summary.unpricedCalls > 0 ? ` · ${summary.unpricedCalls} unpriced` : ''
          }`
        : firmWide ? 'No AI spend recorded for the firm yet' : 'No AI spend on this deal yet';

  return (
    <details
      aria-label={firmWide ? 'Firm AI spend' : 'AI spend'}
      open={expanded || undefined}
      className="mt-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-baseline justify-between rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)] gap-[var(--space-3)] font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
        <span className="bank-label">{firmWide ? 'Firm AI spend' : 'AI spend'}</span>
        <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{headline}</span>
      </summary>
      {firmWide && current?.status === 'ready' ? (
        <p className="mt-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          Recorded usage across the firm, including work outside a deal.
        </p>
      ) : null}
      {summary && summary.calls > 0 ? (
        <div className={`mt-[var(--space-3)] grid gap-[var(--space-4)] ${firmWide ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
          {firmWide ? <SpendTable title="By deal" lines={summary.byDeal} /> : null}
          <SpendTable title="By person" lines={summary.byPerson} />
          <SpendTable title="By task" lines={summary.byTask} />
          <SpendTable title="By model" lines={summary.byModel} />
        </div>
      ) : null}
    </details>
  );
}

function SpendTable({ title, lines }: { title: string; lines: SpendLine[] }) {
  return (
    <table className="min-w-0 w-full border-collapse text-[length:var(--text-xs)]" aria-label={title}>
      {lines.length > 8 ? (
        <caption className="caption-bottom pt-2 text-left text-[var(--ink-secondary)]">Showing the top 8 of {lines.length}, ordered by recorded spend</caption>
      ) : null}
      <thead>
        <tr className="text-left text-[var(--ink-tertiary)]">
          <th className="pb-1 font-medium">{title}</th>
          <th className="pb-1 text-right font-medium">API calls</th>
          <th className="pb-1 text-right font-medium">USD</th>
        </tr>
      </thead>
      <tbody>
        {lines.slice(0, 8).map((line) => (
          <tr key={line.key} className="border-t border-[var(--stroke)]">
            <td className="break-words py-1 pr-2 text-[var(--ink)]">{line.label}</td>
            <td className="py-1 text-right font-mono tabular-nums text-[var(--ink-secondary)]">{line.calls}</td>
            <td className="py-1 text-right font-mono tabular-nums text-[var(--ink)]">
              {line.pricedCalls > 0 ? formatUsd(line.costUsd) : 'No price data'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
