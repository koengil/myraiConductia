import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import FounderReadPanel from '../src/components/acquirers/FounderReadPanel';

describe('FounderReadPanel', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the founder name, scenario titles, likelihoods, and retention risks from the seam', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<FounderReadPanel acquirerId="anthropic" />);

    // The async fetch resolves and the founder name appears in the title.
    expect(
      await screen.findByText(/Founder read · Mike Cannon-Brookes/),
    ).toBeInTheDocument();

    // At least one scenario title — the lead "Stay on as exec" row.
    expect(screen.getByText(/Stay on as exec/)).toBeInTheDocument();

    // Likelihood labels (one per scenario, three in total in fixtures).
    expect(screen.getByText('Most likely')).toBeInTheDocument();
    expect(screen.getByText('Plausible')).toBeInTheDocument();
    expect(screen.getByText('Tail risk')).toBeInTheDocument();

    // Retention-risk labels (one per scenario).
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('Moderate')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();

    // Happy path: no console.error noise.
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
