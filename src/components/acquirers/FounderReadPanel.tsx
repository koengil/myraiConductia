'use client';

import * as React from 'react';

import type {
  FounderLikelihood,
  FounderRead,
  FounderRetentionRisk,
} from '@/lib/api/types';

import { getApi } from '@/lib/api';
import { useProjectId } from '@/lib/project/useProjectId';
import { Badge, Card, type BadgeTone } from '@/components/atoms';

export type FounderReadPanelProps = {
  acquirerId: string;
};

/**
 * Founder Read — post-deal role and autonomy scenarios.
 *
 * A structured synthesis of public signal (founder statements, prior deal
 * posture, governance) rendered as three qualitative scenarios with a
 * likelihood pill and a retention-risk chip. NOT psychological profiling.
 * Specific equity structures and earn-out terms are NEEDS-DATA per mandate,
 * which is called out explicitly in the footer (see the CLAUDE.md thesis:
 * "decisions, not data" — every figure is sourced, every gap is named).
 *
 * Data flows through the seam: getApi().getFounderRead(acquirerId). The panel
 * never reaches around the ConductiaAPI interface. LoadState mirrors the
 * established pattern in src/app/acquirers/[id]/page.tsx — loading | ready |
 * error, with an unmount-safe `active` flag and a structured console.error on
 * failure.
 */

type LoadState = 'loading' | 'ready' | 'error';

const LIKELIHOOD_TONE: Record<FounderLikelihood, BadgeTone> = {
  'Most likely': 'positive',
  Plausible: 'accent',
  'Tail risk': 'negative',
};

const RETENTION_TONE: Record<FounderRetentionRisk, BadgeTone> = {
  Low: 'positive',
  Moderate: 'hold',
  High: 'negative',
};

export function FounderReadPanel({ acquirerId }: FounderReadPanelProps) {
  const dealId = useProjectId();
  const [data, setData] = React.useState<FounderRead | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');

  React.useEffect(() => {
    let active = true;
    const api = getApi();

    async function load() {
      try {
        const result = await api.getFounderRead(dealId, acquirerId);
        if (!active) return;
        setData(result);
        setLoadState('ready');
      } catch (err) {
        if (!active) return;
        console.error('[FounderReadPanel] failed to load founder read', {
          err,
          acquirerId,
        });
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [dealId, acquirerId]);

  if (loadState === 'loading') {
    return (
      <Card aria-label="Founder read">
        <p
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          aria-live="polite"
        >
          Loading the founder read…
        </p>
      </Card>
    );
  }

  if (loadState === 'error' || !data) {
    return (
      <Card aria-label="Founder read">
        <p
          role="status"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          The founder read could not be loaded right now.
        </p>
      </Card>
    );
  }

  return (
    <Card aria-label="Founder read">
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">
          Post-deal role · autonomy scenarios
        </span>
        <h3 className="display-1 text-[var(--ink)]">
          {`Founder read · ${data.founderName}`}
        </h3>
      </div>

      <ul className="mt-[var(--space-8)] flex flex-col gap-[var(--space-4)]">
        {data.scenarios.map((scenario) => (
          <li
            key={scenario.title}
            className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] bg-[var(--surface)] p-[var(--space-5)] ring-1 ring-inset ring-[var(--stroke)]"
          >
            <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
              <h4 className="font-sans text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink)]">
                {scenario.title}
              </h4>
              <Badge tone={LIKELIHOOD_TONE[scenario.likelihood]}>
                {scenario.likelihood}
              </Badge>
            </div>

            <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink-secondary)]">
              {scenario.desc}
            </p>

            <div className="flex flex-wrap items-center gap-[var(--space-3)] pt-[var(--space-2)]">
              <span className="eyebrow">
                Retention risk
              </span>
              <Badge tone={RETENTION_TONE[scenario.retentionRisk]}>
                {scenario.retentionRisk}
              </Badge>
              <span className="font-sans text-[length:var(--text-xs)] italic leading-relaxed text-[var(--ink-tertiary)]">
                {scenario.signal}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-[var(--space-6)] font-sans text-[length:var(--text-xs)] leading-relaxed text-[var(--ink-tertiary)]">
        Structured synthesis of public signal: filings, founder statements,
        prior deal posture. Not psychological profiling. Specific equity
        structures and earn-out terms are NEEDS-DATA per mandate.
      </p>
    </Card>
  );
}

export default FounderReadPanel;
