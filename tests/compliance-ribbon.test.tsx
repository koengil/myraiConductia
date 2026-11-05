import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as React from 'react';
import { ComplianceRibbon } from '../src/components/compliance/ComplianceRibbon';
import { SessionProvider, useSession } from '../src/lib/session/store';
import type { ComplianceStatus } from '../src/lib/api/types';

// Test harness: exposes the session dispatch so a test can drive the
// compliance status the same way the running app's composer/skill runner will.
let driveCompliance: (status: ComplianceStatus) => void;

function ComplianceDriver() {
  const { dispatch } = useSession();
  // Established repo test-probe pattern: a render-phase handle to dispatch is
  // exposed via a module-scoped binding so a test can drive compliance like
  // the app's composer/skill-runner. Deterministic and intentional; a
  // react-hooks/globals refactor across the suite is riskier than this lint.
  // eslint-disable-next-line react-hooks/globals
  driveCompliance = (status: ComplianceStatus) =>
    dispatch({ type: 'SET_COMPLIANCE', status });
  return null;
}

function renderRibbon() {
  return render(
    <SessionProvider>
      <ComplianceDriver />
      <ComplianceRibbon />
    </SessionProvider>,
  );
}

describe('ComplianceRibbon', () => {
  it('renders the idle instrument without visible copy (hover title carries the label)', () => {
    renderRibbon();
    expect(screen.queryByText('Compliance monitoring active')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-compliance-status',
      'idle',
    );
    expect(screen.getByRole('status')).toHaveAttribute(
      'title',
      'Compliance monitoring active',
    );
  });

  it('shows the scanning label when compliance status is scanning', () => {
    renderRibbon();
    act(() => driveCompliance('scanning'));
    expect(screen.getByText('Checking compliance…')).toBeInTheDocument();
    expect(
      screen.queryByText('Compliance monitoring active'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-compliance-status',
      'scanning',
    );
  });

  it('shows the compliant label when compliance status is clear', () => {
    renderRibbon();
    act(() => driveCompliance('clear'));
    expect(screen.getByText('Compliant')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-compliance-status',
      'clear',
    );
  });

  it('shows a blocked message when compliance status is blocked', () => {
    renderRibbon();
    act(() => driveCompliance('blocked'));
    expect(screen.getByText('Blocked, not compliant')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-compliance-status',
      'blocked',
    );
  });

  // Added Phase B of the sandbox merge (ADR-0003) — the fifth UI state.
  it('shows the hold label when compliance status is hold', () => {
    renderRibbon();
    act(() => driveCompliance('hold'));
    expect(screen.getByText('Hold for review')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-compliance-status',
      'hold',
    );
  });

  it('transitions across all five states in sequence', () => {
    renderRibbon();

    act(() => driveCompliance('scanning'));
    expect(screen.getByText('Checking compliance…')).toBeInTheDocument();

    act(() => driveCompliance('clear'));
    expect(screen.getByText('Compliant')).toBeInTheDocument();

    act(() => driveCompliance('hold'));
    expect(screen.getByText('Hold for review')).toBeInTheDocument();

    act(() => driveCompliance('blocked'));
    expect(screen.getByText('Blocked, not compliant')).toBeInTheDocument();

    act(() => driveCompliance('idle'));
    expect(screen.queryByText('Compliance monitoring active')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'title',
      'Compliance monitoring active',
    );
  });

  it('exposes an accessible live-region status label', () => {
    renderRibbon();
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute(
      'aria-label',
      'Compliance status: Compliance monitoring active',
    );
  });
});
