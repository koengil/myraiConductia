import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as React from 'react';

import CultureMatrixPanel from '../src/components/acquirers/CultureMatrixPanel';

/*
 * CultureMatrixPanel — Phase D of the sandbox merge (2026-05-20).
 *
 * The panel self-fetches `getApi().getCultureMatrix(acquirerId)` on mount
 * (and on every `acquirerId` change) and renders the four Bain fault lines
 * with a tinted verdict pill, body copy, and a mono signal footer per row.
 * The Salesforce ↔ Anthropic toggle from the sandbox source is intentionally
 * dropped — `/acquirers/[id]` already scopes to one acquirer per route.
 *
 * Silence contract (matches the rest of the suite): zero `console.error`
 * on the happy path.
 */

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe('CultureMatrixPanel', () => {
  it('renders the four Bain fault lines for the Anthropic acquirer', async () => {
    render(<CultureMatrixPanel acquirerId="anthropic" />);

    // The four canonical fault-line names from the seam fixture. All four
    // must surface for the panel to be carrying real data through the seam.
    expect(
      await screen.findByRole('heading', {
        name: 'Differences in purpose',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Differences in decision-making' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Differences in engagement' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Founder compatibility' }),
    ).toBeInTheDocument();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('surfaces Salesforce-specific reading copy when scoped to salesforce', async () => {
    render(<CultureMatrixPanel acquirerId="salesforce" />);

    // Wait for ready state by anchoring on a known fault-line heading first.
    await screen.findByRole('heading', { name: 'Differences in purpose' });

    // Two Salesforce-only substrings from the fixture reading — at least
    // one must surface to prove the panel routed the right acquirer.
    const purposeMatch = screen.queryByText(/Atlassian's purpose centres/);
    const decisionMatch = screen.queryByText(/consensus-heavy and sales-led/);
    expect(purposeMatch || decisionMatch).not.toBeNull();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('renders both Strong and Watch verdict pills in the Anthropic render', async () => {
    render(<CultureMatrixPanel acquirerId="anthropic" />);

    // Anthropic's reading has three "Strong" fault lines and one "Watch"
    // (Founder compatibility) per the fixture — assert both pill labels
    // appear so the strong → positive and watch → hold tone mapping is
    // exercised on a single render.
    expect(await screen.findAllByText('Strong')).not.toHaveLength(0);
    expect(screen.getByText('Watch')).toBeInTheDocument();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
