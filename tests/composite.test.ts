import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  computeCompositeScore,
  computeDealReadiness,
  computeWeightedScore,
} from '../src/lib/scoring/composite';
import { acquirers } from '../src/lib/api/fixtures';

const fitOf = (id: string) =>
  acquirers.find((a) => a.id === id)!.fitInputs;

const score = (id: string) => computeCompositeScore(fitOf(id));
const scoreAt = (id: string, financial: number, culture: number) =>
  computeWeightedScore(fitOf(id), { financial, culture });

describe('computeCompositeScore — default-weight floor (locked by D9 + ADR-0002)', () => {
  it('Anthropic totals 87 (financialSub 84, cultureSub 91)', () => {
    const s = score('anthropic');
    expect(s.financialSub).toBe(84);
    expect(s.cultureSub).toBe(91);
    expect(s.total).toBe(87);
    expect(s.compliancePassed).toBe(true);
    expect(s.breakdown.length).toBeGreaterThanOrEqual(2);
  });

  it('Salesforce totals 67 (financialSub 71, cultureSub 62)', () => {
    const s = score('salesforce');
    expect(s.financialSub).toBe(71);
    expect(s.cultureSub).toBe(62);
    expect(s.total).toBe(67);
  });

  it('computeWeightedScore with explicit DEFAULT_WEIGHTS matches the default function', () => {
    const a = score('anthropic');
    const b = computeWeightedScore(fitOf('anthropic'), DEFAULT_WEIGHTS);
    expect(b.total).toBe(a.total);
    expect(b.financialSub).toBe(a.financialSub);
    expect(b.cultureSub).toBe(a.cultureSub);
  });
});

describe('computeWeightedScore — variant weights re-tally the composite', () => {
  it('financial-only weights yield the financial subscore', () => {
    expect(scoreAt('anthropic', 100, 0).total).toBe(84);
    expect(scoreAt('salesforce', 100, 0).total).toBe(71);
  });

  it('culture-only weights yield the culture subscore', () => {
    expect(scoreAt('anthropic', 0, 100).total).toBe(91);
    expect(scoreAt('salesforce', 0, 100).total).toBe(62);
  });

  it('weights need not sum to 100 — the function normalises', () => {
    const a = scoreAt('anthropic', 55, 45);
    const b = scoreAt('anthropic', 110, 90);
    const c = scoreAt('anthropic', 11, 9);
    expect(b.total).toBe(a.total);
    expect(c.total).toBe(a.total);
  });

  it('negative weights are clamped at 0', () => {
    const clamped = scoreAt('anthropic', -50, 50);
    const expected = scoreAt('anthropic', 0, 50);
    expect(clamped.total).toBe(expected.total);
  });
});

describe('computeWeightedScore — degenerate input', () => {
  it('all-zero weights fall back to the simple mean of subs (no NaN)', () => {
    // Anthropic financialSub=84, cultureSub=91 → simple mean = 87.5 → 88
    const s = scoreAt('anthropic', 0, 0);
    expect(s.total).toBe(88);
    expect(s.financialSub).toBe(84);
    expect(s.cultureSub).toBe(91);
  });
});

describe('computeDealReadiness — distinct from the Acquirer Fit composite', () => {
  // Guards against the regression where Deal Readiness pushed a panel that
  // looked identical to Acquirer Fit (same total, same breakdown). The
  // readiness score is the 4-axis financial-capacity mean with a reframed
  // breakdown; it must visibly differ from the composite for the fixture
  // acquirers.
  it('produces the 4-axis readiness breakdown with capacity labels', () => {
    const r = computeDealReadiness(fitOf('anthropic'));
    expect(r.breakdown.map((b) => b.label)).toEqual([
      'Cash capacity',
      'Equity / valuation coverage',
      'Growth runway',
      'Margin headroom',
    ]);
  });

  it('Anthropic readiness 84 — distinct from composite 87', () => {
    const r = computeDealReadiness(fitOf('anthropic'));
    expect(r.total).toBe(84);
    expect(score('anthropic').total).toBe(87);
    expect(r.total).not.toBe(score('anthropic').total);
  });

  it('Salesforce readiness 71 — distinct from composite 67', () => {
    const r = computeDealReadiness(fitOf('salesforce'));
    expect(r.total).toBe(71);
    expect(score('salesforce').total).toBe(67);
    expect(r.total).not.toBe(score('salesforce').total);
  });
});

describe('computeWeightedScore — re-rank under variant weights', () => {
  // At default weights the ranking is led by Anthropic; the mid-pack
  // ordering between Adobe and Microsoft depends on bucket weighting.
  // Demonstrates that "moving a weight can flip the ranking" is real for
  // this fixture set (per ADR-0002), even when the top slot stays put.
  it('culture-only weights put Adobe ahead of Microsoft', () => {
    const adobe = scoreAt('adobe', 0, 100).total;
    const microsoft = scoreAt('microsoft', 0, 100).total;
    expect(adobe).toBeGreaterThan(microsoft);
  });

  it('financial-only weights put Microsoft ahead of Adobe', () => {
    const adobe = scoreAt('adobe', 100, 0).total;
    const microsoft = scoreAt('microsoft', 100, 0).total;
    expect(microsoft).toBeGreaterThan(adobe);
  });

  it('Anthropic remains the rank-1 acquirer under any bucket-only weighting (this fixture)', () => {
    // Across the full bucket-weight range, Anthropic's financial AND culture
    // subscores both exceed Salesforce's — so the ranking-1 position is
    // stable for the locked Atlassian fixture under bucket-only sliders.
    // Per-factor sliders (future phase) may unlock flips at the top.
    for (let w = 0; w <= 100; w += 25) {
      const anth = scoreAt('anthropic', w, 100 - w).total;
      const sf = scoreAt('salesforce', w, 100 - w).total;
      expect(anth).toBeGreaterThan(sf);
    }
  });
});
