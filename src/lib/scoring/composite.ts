import type { FitInputs, CompositeScore } from '../api/types';

/**
 * Composite acquirer score — deterministic, pure, fixture-driven.
 *
 * Two-level model (A's data shape):
 *   financialSub = unweighted mean of the 4 FinancialFactors fields
 *   cultureSub   = unweighted mean of the 7 CultureFactors fields
 *   total        = weighted mean of the two subs, weights user-supplied
 *
 * Phase C of the sandbox merge (2026-05-20) generalised this from a fixed
 * 0.55 / 0.45 weighting to user-editable weights per ADR-0002. Default
 * weights still produce the locked floor fixtures (Anthropic 87,
 * Salesforce 67) byte-for-byte. The slider mechanic in /acquirers/[id]
 * lets the MD move the weights and see the ranking re-tally live.
 *
 * D9 invariant: pure function, deterministic, no hardcoded outputs.
 * ADR-0002 floor: default-weight scores 87 / 67 preserved byte-identical.
 */

export interface ScoreWeights {
  /** Weight on the financial bucket. Default 55. */
  financial: number;
  /** Weight on the culture bucket. Default 45. */
  culture: number;
}

/**
 * Default bucket weights — financial 55, culture 45. The numeric scale is
 * irrelevant (the function normalises), but 0-100 percentages match the
 * slider UI and read naturally. At defaults the composite produces the
 * locked fixture floor (Anthropic 87, Salesforce 67).
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  financial: 55,
  culture: 45,
};

function mean(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Compute the composite score under arbitrary bucket weights. Weights are
 * clamped at 0 and normalised so they need not sum to 1 — the UI can move
 * one slider without rebalancing the other. If both weights are zero
 * (degenerate input) the function falls back to the unweighted mean of the
 * two subs so the surface never shows NaN.
 */
export function computeWeightedScore(
  fit: FitInputs,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): CompositeScore {
  const f = fit.financial;
  const c = fit.culture;
  const financialSub = Math.round(
    mean([f.valuationCoverage, f.cashCapacity, f.growth, f.margin]),
  );
  const cultureSub = Math.round(
    mean([c.vision, c.mission, c.founder, c.headcount, c.industry, c.product, c.culture]),
  );

  const wFinancial = Math.max(0, weights.financial);
  const wCulture = Math.max(0, weights.culture);
  const totalWeight = wFinancial + wCulture;

  const total =
    totalWeight <= 0
      ? Math.round((financialSub + cultureSub) / 2)
      : Math.round((wFinancial * financialSub + wCulture * cultureSub) / totalWeight);

  return {
    total,
    financialSub,
    cultureSub,
    compliancePassed: true,
    breakdown: [
      { label: 'Financial fit', value: financialSub },
      { label: 'Culture & strategic fit', value: cultureSub },
    ],
  };
}

/**
 * Backwards-compatible wrapper. The default-weights call site (the API mock
 * and any consumer that does not know about variant weights) stays
 * untouched; default weights produce the locked fixture floor.
 */
export function computeCompositeScore(fit: FitInputs): CompositeScore {
  return computeWeightedScore(fit, DEFAULT_WEIGHTS);
}

/**
 * Deal-readiness score — the operational-capacity read on an acquirer, distinct
 * from the strategic Acquirer Fit composite.
 *
 * The two skills share the `compositeScore` wire shape (ADR-0005: panel
 * rendering belongs on the client, not in the wire contract) but mean
 * different things to the MD: Acquirer Fit weights strategic alignment;
 * Deal Readiness reads the acquirer's *capacity to close*. Re-uses the
 * four FinancialFactors fields as the readiness axes — no new fixture data
 * needed — but reframes them as cash / equity / growth runway / margin
 * headroom so the panel reads as a genuinely different intelligence unit.
 *
 * Deterministic, pure, fixture-driven — same D9 contract as the composite.
 */
export function computeDealReadiness(fit: FitInputs): CompositeScore {
  const f = fit.financial;
  const cash = f.cashCapacity;
  const equity = f.valuationCoverage;
  const growth = f.growth;
  const margin = f.margin;
  const total = Math.round(mean([cash, equity, growth, margin]));

  return {
    total,
    // The Composite-score type carries financialSub / cultureSub for the
    // dial trace. Deal Readiness is single-axis (capacity), so both subs
    // mirror the total — keeps the existing CompositeScore consumers happy
    // without inventing a parallel shape.
    financialSub: total,
    cultureSub: total,
    compliancePassed: true,
    breakdown: [
      { label: 'Cash capacity', value: cash },
      { label: 'Equity / valuation coverage', value: equity },
      { label: 'Growth runway', value: growth },
      { label: 'Margin headroom', value: margin },
    ],
  };
}
