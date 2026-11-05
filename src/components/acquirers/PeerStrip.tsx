'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';

import type { Company } from '@/lib/api/types';
import { resolveProjectId } from '@/lib/project/resolveProjectId';
import { resolveDeal } from '@/lib/rail/deals';

export type PeerStripProps = {
  peers: Company[];
};

/**
 * Compact USD formatting: $4.4B / $700M readable, not raw digits.
 * Demo-scale figures only — billions and millions are sufficient.
 */
function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `$${trim(value / 1_000_000_000)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${trim(value / 1_000_000)}M`;
  }
  return `$${trim(value / 1_000)}K`;
}

function trim(n: number): string {
  // One decimal, but drop a trailing ".0" so $4B not $4.0B.
  return n
    .toFixed(1)
    .replace(/\.0$/, '');
}

function formatHeadcount(value: number): string {
  if (value >= 1_000) {
    return `${trim(value / 1_000)}k`;
  }
  return String(value);
}

/**
 * Peer strip — Atlassian's comparable company set (personas-and-jobs Job 2:
 * "Benchmark myself against my peer set").
 *
 * The prior eyebrow read "Who you sit next to" — internal shorthand from the
 * Job 2 phrasing that leaked into the UI and read as a riddle, not a label. An
 * MD scanning the board could not tell WHO it referred to. Reframed to the
 * comps an MD names instantly: the public/late-stage SaaS companies
 * (Figma, Canva) Atlassian is read against. These are the marks that anchor the
 * valuation and, by extension, the acquirer fit ranked above — a buyer prices
 * Atlassian against this set before any conversation begins.
 *
 * Comparable companies by revenue, headcount, and growth. Deliberately the
 * quietest surface on the board relative to the ranked acquirer decision:
 * muted tokens, a single rail, no dial, no affordance. Context, not a
 * decision.
 *
 * Responsive (design spec §5): a horizontal scroll-snap rail on mobile so it
 * never competes with the decision above; a calm even row from `sm` up.
 * Presentational only.
 *
 * CONTRACT (ledger §3.2 — preserved): `aria-label="Comparable companies"`,
 * per-peer `aria-label={peer.name}`, the formatting helpers byte-identical.
 */
export function PeerStrip({ peers }: PeerStripProps) {
  // COMPLIANCE: label the comp set by the deal CODE NAME, never the target
  // company — printing the seller's real name here would defeat the masking.
  const params = useParams();
  const projectId = resolveProjectId(
    params?.projectId as string | string[] | undefined,
  );
  const codename = resolveDeal(projectId)?.codename ?? projectId;

  if (peers.length === 0) return null;

  return (
    <section
      aria-label="Comparable companies"
      className={
        'flex flex-col gap-[var(--space-4)] ' +
        'border-t border-[var(--stroke)] pt-[var(--space-8)]'
      }
    >
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">Comparable set</span>
        <p className="caption max-w-2xl text-[var(--ink-secondary)]">
          The comps a buyer prices {codename} against. The valuation and the
          acquirer fit above are read against this set.
        </p>
      </div>

      <ul
        className={
          'flex snap-x snap-mandatory gap-[var(--space-3)] ' +
          'overflow-x-auto pb-[var(--space-2)] ' +
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden ' +
          'sm:grid sm:grid-cols-2 sm:overflow-visible'
        }
      >
        {peers.map((peer) => (
          <li
            key={peer.id}
            aria-label={peer.name}
            className={
              'flex min-w-[78%] shrink-0 snap-start flex-col ' +
              'gap-[var(--space-2)] rounded-[var(--radius-card)] ' +
              'bg-[var(--surface-subtle)] px-[var(--space-5)] ' +
              'py-[var(--space-4)] sm:min-w-0 sm:shrink ' +
              'ring-1 ring-inset ring-[var(--stroke)]'
            }
          >
            <span className="text-[length:var(--text-md)] font-medium text-[var(--ink)]">
              {peer.name}
            </span>
            <dl className="flex flex-wrap gap-x-[var(--space-6)] gap-y-[var(--space-1)]">
              <PeerStat
                label="Revenue"
                value={formatUsd(peer.financials.revenueUsd)}
              />
              <PeerStat
                label="People"
                value={formatHeadcount(peer.financials.headcount)}
              />
              <PeerStat
                label="Growth"
                value={`${peer.financials.revenueGrowthPct}%`}
              />
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PeerStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-[2px]">
      <dt className="eyebrow text-[var(--ink-tertiary)]">{label}</dt>
      <dd className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {value}
      </dd>
    </div>
  );
}

export default PeerStrip;
