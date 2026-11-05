'use client';

import * as React from 'react';

import {
  DEFAULT_WEIGHTS,
  type ScoreWeights,
} from '@/lib/scoring/composite';

/**
 * Bucket-weights slider for the acquirer deep-dive composite score.
 *
 * Phase C of the sandbox merge (2026-05-20), per ADR-0002. The MD moves the
 * weight between the financial bucket and the culture bucket; the composite
 * recomputes live in the parent. Default weights (55 / 45) reproduce the
 * locked fixture floor `Anthropic 87 / Salesforce 67` byte-identical.
 *
 * Per-factor sliders (over the 11 sub-factors) are out of scope here; bucket
 * sliders are the smallest correct port that ships the determinism mechanic.
 *
 * Controlled component: weights live in the parent so the score and the
 * sliders stay in lockstep. Internal model: weights are 0-100 percentages
 * that auto-balance to sum to 100 (move one slider, the other adjusts).
 */

export type ScoreWeightsControlProps = {
  weights: ScoreWeights;
  onWeightsChange: (next: ScoreWeights) => void;
  surface?: 'light' | 'dark';
};

const SLIDER_BASE =
  'h-[3px] w-full cursor-pointer appearance-none rounded-full ' +
  // Workbench register: the native range thumb + filled track segment take
  // ink. Without this the browser uses its default blue thumb which reads
  // off-register against the warm workbench surfaces.
  '[accent-color:var(--ink)] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2';

export function ScoreWeightsControl({ weights, onWeightsChange }: ScoreWeightsControlProps) {
  const labelClass = 'eyebrow text-[var(--ink-tertiary)]';
  const valueClass = 'font-mono text-[length:var(--text-sm)] tabular-nums text-[var(--ink)]';
  const trackClass = 'bg-[var(--surface-subtle)]';
  const resetClass =
    'font-sans text-[length:var(--text-xs)] font-medium text-[var(--ink-tertiary)] underline-offset-4 outline-none transition-colors hover:text-[var(--ink)] focus-visible:underline';

  // Auto-balancing two-slider model: moving one slider adjusts the other so
  // the pair always sums to 100. The composite function normalises anyway,
  // but the visible sum stays at 100% which reads naturally.
  const setBucket = (bucket: keyof ScoreWeights, value: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    if (bucket === 'financial') {
      onWeightsChange({ financial: clamped, culture: 100 - clamped });
    } else {
      onWeightsChange({ financial: 100 - clamped, culture: clamped });
    }
  };

  const isDefault =
    weights.financial === DEFAULT_WEIGHTS.financial &&
    weights.culture === DEFAULT_WEIGHTS.culture;

  return (
    <div
      aria-label="Composite score weights"
      className="flex flex-col gap-[var(--space-4)]"
    >
      <div className="flex items-baseline justify-between gap-[var(--space-4)]">
        <span className={labelClass}>Score weights</span>
        <button
          type="button"
          onClick={() => onWeightsChange(DEFAULT_WEIGHTS)}
          disabled={isDefault}
          className={resetClass + ' disabled:cursor-default disabled:opacity-40'}
        >
          Reset
        </button>
      </div>

      <div className="flex flex-col gap-[var(--space-3)]">
        <div className="flex items-center justify-between gap-[var(--space-3)]">
          <label htmlFor="weight-financial" className={labelClass}>
            Financial
          </label>
          <span className={valueClass}>{weights.financial}%</span>
        </div>
        <input
          id="weight-financial"
          type="range"
          min={0}
          max={100}
          step={1}
          value={weights.financial}
          onChange={(e) => setBucket('financial', Number(e.target.value))}
          aria-label="Financial bucket weight"
          aria-valuetext={`Financial ${weights.financial} percent`}
          className={`${SLIDER_BASE} ${trackClass}`}
        />
      </div>

      <div className="flex flex-col gap-[var(--space-3)]">
        <div className="flex items-center justify-between gap-[var(--space-3)]">
          <label htmlFor="weight-culture" className={labelClass}>
            Culture &amp; strategic
          </label>
          <span className={valueClass}>{weights.culture}%</span>
        </div>
        <input
          id="weight-culture"
          type="range"
          min={0}
          max={100}
          step={1}
          value={weights.culture}
          onChange={(e) => setBucket('culture', Number(e.target.value))}
          aria-label="Culture and strategic bucket weight"
          aria-valuetext={`Culture and strategic ${weights.culture} percent`}
          className={`${SLIDER_BASE} ${trackClass}`}
        />
      </div>
    </div>
  );
}

export default ScoreWeightsControl;
