import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as React from 'react';

import FootballFieldPanel from '../src/components/acquirers/FootballFieldPanel';

/*
 * FootballFieldPanel — Phase D of the sandbox merge (2026-05-20).
 *
 * The panel self-fetches `getApi().getValuation()` on mount and renders the
 * envelope as a Card with eyebrow + display-1 title, a list of range-bar
 * rows, and a trace footer. The live mock seam already returns the
 * Atlassian-grounded fixture (no overrides needed), so these tests render
 * the component bare and assert the post-fetch surface.
 *
 * Silence contract (matches the rest of the suite): zero `console.error`
 * on the happy path. The error path mirrors `/acquirers/[id]`'s shape and
 * is covered by the component's typed catch — not exercised here.
 */

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe('FootballFieldPanel', () => {
  it('renders the eyebrow and display-1 title after the seam resolves', async () => {
    render(<FootballFieldPanel />);

    expect(await screen.findByText('Valuation envelope')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Football field' }),
    ).toBeInTheDocument();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('shows at least one fixture row name from the valuation envelope', async () => {
    render(<FootballFieldPanel />);

    // The Atlassian fixture's grounded rows — at least one of these must
    // surface for the panel to be carrying real data through the seam.
    expect(await screen.findByText('Trading (today)')).toBeInTheDocument();
    expect(screen.getByText('52-week range')).toBeInTheDocument();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('surfaces the // NEEDS-DATA marker for placeholder rows', async () => {
    render(<FootballFieldPanel />);

    // Wait for the panel to finish loading by anchoring on a known row.
    await screen.findByText('Trading (today)');

    // Multiple fixture rows carry `needsData: true` (Comp set, DCF,
    // Precedent transactions). The marker is rendered verbatim per the
    // sandbox spec — gaps flagged, not fabricated.
    const markers = screen.getAllByText('// NEEDS-DATA');
    expect(markers.length).toBeGreaterThanOrEqual(1);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('renders the trace footer with the three grounded figures', async () => {
    render(<FootballFieldPanel />);

    // Wait for ready state.
    await screen.findByText('Trading (today)');

    // Trace eyebrow + the three mono-rendered values from the fixture.
    expect(screen.getByText('Trace')).toBeInTheDocument();
    expect(screen.getByText('$6.2B')).toBeInTheDocument();
    expect(screen.getByText('86.5%')).toBeInTheDocument();
    expect(screen.getByText('+32%')).toBeInTheDocument();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
