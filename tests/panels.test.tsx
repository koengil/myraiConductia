import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import type {
  Company,
  CultureFactors,
  CompositeScore,
} from '../src/lib/api/types';
import FinancialMatrixPanel from '../src/components/panels/FinancialMatrixPanel';
import CultureRadarPanel from '../src/components/panels/CultureRadarPanel';
import ScoreBreakdownPanel from '../src/components/panels/ScoreBreakdownPanel';

// Inline literal sample props — the panels are pure-presentational and must be
// testable in isolation without importing fixtures. Shapes match types.ts.
const SAMPLE_COMPANY: Company = {
  id: 'acme',
  name: 'Acme Corp',
  kind: 'acquirer',
  tagline: 'A strategic incumbent',
  financials: {
    valuationUsd: 34_900_000_000,
    revenueUsd: 700_000_000,
    revenueGrowthPct: 18,
    ebitdaUsd: 120_000_000,
    ebitdaMarginPct: 17.1,
    cashUsd: 4_200_000_000,
    headcount: 6500,
  },
};

const SAMPLE_FACTORS: CultureFactors = {
  vision: 88,
  mission: 76,
  founder: 91,
  headcount: 64,
  industry: 80,
  product: 72,
  culture: 85,
};

const SAMPLE_SCORE: CompositeScore = {
  total: 87,
  financialSub: 84,
  cultureSub: 91,
  breakdown: [
    { label: 'Financial fit', value: 84 },
    { label: 'Culture fit', value: 91 },
  ],
  compliancePassed: true,
};

describe('FinancialMatrixPanel', () => {
  it('shows a human-readable formatted revenue figure', () => {
    render(<FinancialMatrixPanel company={SAMPLE_COMPANY} />);
    // 700,000,000 → $700.0M
    expect(screen.getByText('$700.0M')).toBeInTheDocument();
  });
});

describe('CultureRadarPanel', () => {
  it('renders all seven axis labels', () => {
    render(<CultureRadarPanel factors={SAMPLE_FACTORS} />);
    for (const label of [
      'Vision',
      'Mission',
      'Founder',
      'Headcount',
      'Industry',
      'Product',
      'Culture',
    ]) {
      // Label appears on the SVG axis AND the mirrored list — both fine.
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('ScoreBreakdownPanel', () => {
  it('shows the composite total and both breakdown labels', () => {
    render(<ScoreBreakdownPanel score={SAMPLE_SCORE} />);
    // ScoreDial renders the clamped total text.
    expect(screen.getByText('87')).toBeInTheDocument();
    expect(screen.getByText('Financial fit')).toBeInTheDocument();
    expect(screen.getByText('Culture fit')).toBeInTheDocument();
    // The compliance stamp — the moat, made visible.
    expect(
      screen.getByText('Verified through the compliance layer'),
    ).toBeInTheDocument();
  });
});
