'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

import type { CompositeScore } from '@/lib/api/types';
import { clamp0to100 } from '@/lib/util/clamp';
import {
  SCORE_REVEAL_DURATION_S,
  SCORE_REVEAL_EASE,
} from '@/components/_shared/motion';
import { Card, ScoreDial } from '@/components/atoms';

export type ScoreBreakdownPanelProps = {
  score: CompositeScore;
  /**
   * Optional eyebrow label. Defaults to `'Composite score'`. The Canvas
   * overrides this with the source-skill name so skills that share the
   * `compositeScore` dataShape (acquirer-fit vs deal-readiness) read
   * distinctly to the MD.
   */
  eyebrow?: string;
  /**
   * Optional heading. Defaults to the generic composite framing. The Canvas
   * passes a skill-specific framing so acquirer-fit and deal-readiness — which
   * share the same underlying score data — do not feel like duplicate panels.
   */
  heading?: string;
};

/**
 * Composite-score breakdown panel — experience-spine Step 4 (a panel rendered
 * on the hero canvas). The headline `ScoreDial` (which already owns its own
 * Score-Reveal sweep, motion-language.md §3) plus each `breakdown[]` factor as
 * a labelled proportional bar (0–100), and the compliance ✓ stamp elevated as
 * a designed assurance — the moat made visible (CLAUDE.md thesis: "compliance
 * is omnipresent"). Light workbench card (kit §10): field-gray tracks, ink
 * fills, solid pastel assurance stamp.
 *
 * Motion — Score Reveal (motion-language.md §3): the dial sweeps via the
 * ScoreDial primitive; the breakdown bars fill from 0 to their value in
 * concert with the same 600ms / slight-overshoot feel used by the radar, so
 * the whole panel reads as computed, not retrieved. `prefers-reduced-motion`
 * renders final-state bars instantly.
 *
 * Pure presentational: every figure comes from `score`. No fetching, no
 * recomputation. The Canvas container label `Composite score breakdown` is
 * asserted (golden-path) and kept byte-stable.
 */

// motion-language.md §3 Score Reveal — same arm/bar extension feel as the
// radar. Shared via _shared/motion.ts (single source of truth).
const BAR_DURATION_S = SCORE_REVEAL_DURATION_S; // 600ms
const BAR_EASE = SCORE_REVEAL_EASE;

export function ScoreBreakdownPanel({
  score,
  eyebrow = 'Composite score',
  heading = 'Weighted financial and culture fit',
}: ScoreBreakdownPanelProps) {
  const reduceMotion = useReducedMotion();

  return (
    <Card aria-label="Composite score breakdown">
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">
          {eyebrow}
        </span>
        <h3 className="font-sans text-[length:var(--text-xl)] font-semibold leading-tight text-[var(--ink)]">
          {heading}
        </h3>
      </div>

      <div className="mt-[var(--space-8)] flex flex-col items-center gap-[var(--space-8)] lg:flex-row lg:items-center lg:gap-[var(--space-12)]">
        <div className="shrink-0">
          <ScoreDial value={score.total} label="Composite" />
        </div>

        <div className="flex w-full flex-col gap-[var(--space-6)]">
          {score.breakdown.map((item) => {
            const pct = clamp0to100(item.value);
            return (
              <div
                key={item.label}
                className="flex flex-col gap-[var(--space-2)]"
              >
                <div className="flex items-baseline justify-between gap-[var(--space-4)]">
                  <span className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                    {item.label}
                  </span>
                  <span className="font-sans text-[length:var(--text-lg)] font-semibold text-[var(--ink)] tabular-nums">
                    {item.value}
                  </span>
                </div>
                <div
                  className="h-[8px] w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--surface-subtle)]"
                  role="meter"
                  aria-label={`${item.label}: ${item.value} out of 100`}
                  aria-valuenow={item.value}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <motion.div
                    className="h-full rounded-[var(--radius-pill)] bg-[var(--ink)]"
                    initial={{ width: reduceMotion ? `${pct}%` : '0%' }}
                    animate={{ width: `${pct}%` }}
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { duration: BAR_DURATION_S, ease: BAR_EASE }
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-[var(--space-8)] flex items-center gap-[var(--space-3)] rounded-[var(--radius-control)] bg-[var(--positive-fill)] px-[var(--space-4)] py-[var(--space-3)]">
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-sans text-[length:var(--text-sm)] text-[var(--positive-deep)]"
        >
          ✓
        </span>
        <span className="font-sans text-[length:var(--text-sm)] font-medium text-[var(--positive-deep)]">
          Verified through the compliance layer
        </span>
      </div>
    </Card>
  );
}

export default ScoreBreakdownPanel;
