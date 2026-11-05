'use client';

import * as React from 'react';

import { Badge } from '@/components/atoms';

/**
 * VitalsStrip — the mandate's instrument row. Four live vitals collapsed into
 * one horizontal, tabular strip the MD scans left-to-right the way they read a
 * terminal header: pipeline depth, the top composite fit, the cleared team,
 * and the always-on compliance state.
 *
 * Live values flow in from the Mandate route's seam load (getAcquirers count,
 * the top composite score + top acquirer name, getTeam count). The compliance
 * vital states the platform-level "Active" status in editorial copy; the live
 * chrome ribbon (mounted in the platform layout) owns the
 * [data-compliance-status] contract — we never duplicate it here.
 *
 * This component is presentation-only — it never touches the seam.
 *
 * CONTRAST: LIGHT surface (--surface). All text is dark ink
 * (--ink / --ink-secondary / --ink-tertiary). No --ink-on-dark* here.
 *
 * The strip owns the [aria-label="Mandate vitals"] region the golden-path
 * route test scopes its assertions to ("5", "87", "Anthropic", "Active").
 */

type Metric = {
  eyebrow: string;
  value: React.ReactNode;
  caption: React.ReactNode;
  /** When set, the eyebrow gets a tone-matched leading dot. */
  dot?: 'positive';
};

export type VitalsStripProps = {
  pipeline: number;
  topScore: number | null;
  topAcquirerName: string | null;
  teamCount: number;
  surface?: 'light' | 'dark';
};

export function VitalsStrip({
  pipeline,
  topScore,
  topAcquirerName,
  teamCount,
  surface = 'light',
}: VitalsStripProps) {
  const metrics: Metric[] = [
    {
      eyebrow: 'Pipeline',
      value: pipeline,
      caption: 'Acquirers scored',
    },
    {
      eyebrow: 'Top fit',
      value: topScore ?? 'Not ranked',
      caption: topAcquirerName ?? 'Unranked',
    },
    {
      eyebrow: 'Team',
      value: teamCount,
      caption: teamCount === 1 ? 'Advisor cleared' : 'Advisors cleared',
    },
    {
      eyebrow: 'Compliance',
      dot: 'positive',
      value: (
        <span className="flex items-baseline gap-(--space-2)">
          <span>Active</span>
          <Badge tone="positive" surface={surface}>
            Live
          </Badge>
        </span>
      ),
      caption: 'Every action screened',
    },
  ];

  return (
    <div
      aria-label="Mandate vitals"
      className={
        'grid grid-cols-2 overflow-hidden rounded-card sm:grid-cols-4 sm:divide-x sm:divide-y-0 ' +
        (surface === 'dark'
          ? 'divide-y divide-(--on-dark-stroke-12) border border-(--on-dark-stroke-12) bg-(--on-dark-fill-04) text-ink-on-dark'
          : 'divide-y divide-stroke border border-stroke bg-surface text-ink')
      }
    >
      {metrics.map((m) => (
        <div
          key={m.eyebrow}
          className="flex flex-col gap-(--space-2) px-(--space-5) py-(--space-4)"
        >
          <span
            className={
              'eyebrow flex items-center gap-(--space-2) ' +
              (surface === 'dark'
                ? 'text-ink-on-dark-secondary'
                : '')
            }
          >
            {m.dot ? (
              <span
                aria-hidden
                className="inline-block h-[6px] w-[6px] rounded-full bg-positive"
              />
            ) : null}
            {m.eyebrow}
          </span>
          <span
            className={
              'data-xl tabular-nums ' +
              (surface === 'dark' ? 'text-ink-on-dark' : 'text-ink')
            }
          >
            {m.value}
          </span>
          <span
            className={
              'truncate font-sans text-(--text-xs) ' +
              (surface === 'dark'
                ? 'text-ink-on-dark-tertiary'
                : 'text-ink-tertiary')
            }
          >
            {m.caption}
          </span>
        </div>
      ))}
    </div>
  );
}

export default VitalsStrip;
