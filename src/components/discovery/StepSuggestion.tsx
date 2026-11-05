'use client';

import * as React from 'react';

import { Badge } from '@/components/atoms/Badge';
import type { CandidateOverride, CandidateStation } from '@/lib/discovery/api';
import { shortPhaseName } from '@/components/rail/railBoardModel';
import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';

/** "Diligence · Step 44 · LOI Review": the phase name leads, the step number follows, no rail total. */
export function stepLine(step: { station: number | null; title: string }): string {
  const nn = step.station === null ? '--' : String(step.station).padStart(2, '0');
  const onRail = step.station === null ? undefined : orderedSteps(MVP_DEAL_RAIL)[step.station - 1];
  const phase = onRail ? MVP_DEAL_RAIL.find((p) => p.steps.some((s) => s.id === onRail.id)) : undefined;
  return phase
    ? `${shortPhaseName(phase.name)} · Step ${nn} · ${step.title}`
    : `Step ${nn} · ${step.title}`;
}

/**
 * The step the evidence suggests for a proposed deal, with the templated
 * reason for it. Ink-outlined like the rail's current-step card: it is a
 * suggestion from mail, so it reads as a proposal, never as the deal's status.
 * (`station` is the API's field name for the step number; it stays.)
 */
export function StepSuggestion({
  station,
  override = null,
}: {
  station: CandidateStation | null;
  override?: CandidateOverride | null;
}) {
  if (override) {
    return (
      <section
        aria-label="Suggested step"
        className="flex flex-col gap-[var(--space-1)] rounded-[var(--radius-card)] border border-[var(--accent)] bg-[var(--surface)] p-[var(--space-4)] shadow-[var(--elev-1)]"
      >
        <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">Step set by a person</p>
        <div className="flex flex-wrap items-center gap-[var(--space-3)]">
          <p className="bank-heading text-[var(--ink)]">
            {stepLine({ station: override.station, title: override.title })}
          </p>
          {station?.lifecycle === 'closed' ? <Badge tone="positive">Closed</Badge> : null}
        </div>
        {override.reason ? (
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{override.reason}</p>
        ) : null}
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {station ? `Evidence suggests ${stepLine({ station: station.station, title: station.title })}` : 'No milestones extracted yet'}
        </p>
      </section>
    );
  }
  if (!station) {
    return (
      <section
        aria-label="Suggested step"
        className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]"
      >
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          No milestones extracted yet
        </p>
      </section>
    );
  }
  return (
    <section
      aria-label="Suggested step"
      className="flex flex-col gap-[var(--space-1)] rounded-[var(--radius-card)] border border-[var(--accent)] bg-[var(--surface)] p-[var(--space-4)] shadow-[var(--elev-1)]"
    >
      <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">Suggested from evidence</p>
      <div className="flex flex-wrap items-center gap-[var(--space-3)]">
        <p className="bank-heading text-[var(--ink)]">{stepLine(station)}</p>
        {station.lifecycle === 'closed' ? <Badge tone="positive">Closed</Badge> : null}
      </div>
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{station.reason}</p>
    </section>
  );
}

export default StepSuggestion;
