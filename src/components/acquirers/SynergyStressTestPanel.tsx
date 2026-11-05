'use client';

import * as React from 'react';


import { getApi } from '@/lib/api';
import { useProjectId } from '@/lib/project/useProjectId';
import type {
  SynergyRow,
  SynergyStressTest,
  SynergyVerdict,
} from '@/lib/api/types';
import { Badge, Card, type BadgeTone } from '@/components/atoms';

export type SynergyStressTestPanelProps = {
  acquirerId: string;
};

/**
 * Synergy stress-test panel — Phase D of the sandbox merge (2026-05-20).
 *
 * Confronts the management synergy case with published M&A base rates. The
 * point: an MD shouldn't read a synergy line in a pro-forma as a forecast.
 * They should read it as a *claim* against priors. McKinsey ("Where mergers
 * go wrong" / "M&A integration") puts cost synergies at ~80% of plan on
 * average and revenue synergies at ~50%. Bain ("Integration playbook")
 * finds 30–50% of total announced synergies are actually captured within
 * two years. This panel lays the management claim next to those priors.
 *
 * Atlassian-specific synergy claims are not yet public (no acquirer has
 * filed an 8-K), so the `managementClaim` reads `// NEEDS-DATA` for each
 * row at this fixture stage. We render that token verbatim but visually
 * mark it (monospace + dimmed) so it reads as scaffolding for a future
 * pro-forma wire, not as a number.
 *
 * Pure presentational over the seam: every figure comes from
 * `getSynergyStressTest(acquirerId)`. No local data; the future backend
 * answers the same shape.
 */

type LoadState = 'loading' | 'ready' | 'error';

const VERDICT_TONE: Record<SynergyVerdict, BadgeTone> = {
  framework: 'neutral',
  stress: 'negative',
  ok: 'positive',
};

const VERDICT_LABEL: Record<SynergyVerdict, string> = {
  framework: 'Awaiting mgmt case',
  stress: 'Stressed',
  ok: 'OK',
};

export function SynergyStressTestPanel({
  acquirerId,
}: SynergyStressTestPanelProps) {
  const dealId = useProjectId();
  const [data, setData] = React.useState<SynergyStressTest | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');

  React.useEffect(() => {
    let active = true;
    const api = getApi();

    async function load() {
      try {
        const result = await api.getSynergyStressTest(dealId, acquirerId);
        if (!active) return;
        setData(result);
        setLoadState('ready');
      } catch (err) {
        if (!active) return;
        console.error(
          '[SynergyStressTestPanel] failed to load synergy stress-test',
          { err, acquirerId },
        );
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [dealId, acquirerId]);

  return (
    <Card aria-label="Synergy stress-test">
      <header className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">
          Management case vs. base rates
        </span>
        <h3 className="display-1 text-[var(--ink)]">Synergy stress-test</h3>
        <p className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          The buyer&rsquo;s promised savings, checked against what deals really deliver.
        </p>
      </header>

      {loadState === 'loading' ? (
        <p
          className="mt-[var(--space-6)] font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          aria-live="polite"
        >
          Loading synergy stress-test.
        </p>
      ) : null}

      {loadState === 'error' ? (
        <p
          className="mt-[var(--space-6)] font-sans text-[length:var(--text-sm)] text-[var(--negative)]"
          role="alert"
        >
          Synergy stress-test unavailable. The service returned an error.
        </p>
      ) : null}

      {loadState === 'ready' && data ? (
        <>
          <ul className="mt-[var(--space-8)] flex flex-col gap-[var(--space-6)]">
            {data.rows.map((row) => (
              <li key={row.label}>
                <SynergyRowView row={row} />
              </li>
            ))}
          </ul>

          <div className="mt-[var(--space-8)] flex items-start gap-[var(--space-3)] rounded-[var(--radius-control)] bg-[var(--negative-fill)] px-[var(--space-4)] py-[var(--space-3)]">
            <span
              aria-hidden="true"
              className="mt-[2px] inline-flex h-5 w-5 shrink-0 items-center justify-center font-sans text-[length:var(--text-sm)] text-[var(--negative-deep)]"
            >
              {'▲'}
            </span>
            <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--negative-deep)]">
              {data.riskNote}
            </p>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function SynergyRowView({ row }: { row: SynergyRow }) {
  const claimIsToken = row.managementClaim.startsWith('//');

  return (
    <div className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] bg-[var(--surface)] p-[var(--space-4)] ring-1 ring-inset ring-[var(--stroke)]">
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="font-sans text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
          {row.label}
        </span>
        <Badge tone={VERDICT_TONE[row.verdict]}>
          {VERDICT_LABEL[row.verdict]}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-[var(--space-4)] sm:grid-cols-2">
        <SynergyCell
          label="Base rate"
          value={row.baseRate}
          note={row.baseRateNote}
        />
        <SynergyCell
          label="Mgmt claim"
          value={row.managementClaim}
          note="Wires once announced"
          valueClassName={
            claimIsToken
              ? 'font-mono text-[length:var(--text-base)] text-[var(--ink-tertiary)]'
              : undefined
          }
        />
      </div>
    </div>
  );
}

function SynergyCell({
  label,
  value,
  note,
  valueClassName,
}: {
  label: string;
  value: string;
  note: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <span className="eyebrow">{label}</span>
      <span
        className={
          valueClassName ??
          'data-xl text-[length:var(--text-lg)] text-[var(--ink)] tabular-nums'
        }
      >
        {value}
      </span>
      <span className="font-sans text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {note}
      </span>
    </div>
  );
}

export default SynergyStressTestPanel;
