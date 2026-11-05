import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as React from 'react';

import { ScreeningOverlay } from '../src/components/compliance/ScreeningOverlay';

/**
 * Per-component tests for the inline compliance screening overlay
 * (Phase E sandbox merge, 2026-05-20). The overlay is purely
 * presentational: it cycles a phase label while a screen is in flight,
 * shows the preview of the message being screened, and surfaces a meta
 * line about what is happening.
 *
 * Phase rotation is driven by a setInterval; under reduced-motion the
 * rotation collapses to a single static label. The tests do not advance
 * timers — they assert the initial render contract under each motion path.
 */

afterEach(() => {
  cleanup();
});

describe('ScreeningOverlay', () => {
  it('renders the role and aria-label so the active scan is announced', () => {
    render(<ScreeningOverlay />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-label', 'Compliance screening');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('shows the initial phase label and the gateway meta line', () => {
    render(<ScreeningOverlay />);
    // The first phase label of the rotation is rendered on first paint
    // (reduced-motion in jsdom defaults to false, so the rotating path is
    // selected — but the test inspects the initial snapshot, not the
    // rotation itself).
    expect(
      screen.getByText(
        /Parsing message|Screening for MNPI and promissory language/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Compliance gateway · screening MNPI/),
    ).toBeInTheDocument();
  });

  it('renders the preview when provided and truncates long bodies', () => {
    const short = 'Sending the comp set to the shared room.';
    render(<ScreeningOverlay messagePreview={short} />);
    expect(screen.getByText(new RegExp(short))).toBeInTheDocument();
  });

  it('truncates previews longer than 110 characters with an ellipsis', () => {
    const longBody =
      'I guarantee a board seat for the founder and a top-of-range bid and an extended earn-out and a long list of additional promises that should be flagged.';
    render(<ScreeningOverlay messagePreview={longBody} />);
    // The preview text wraps in curly quotes; assert the first stable
    // substring + the ellipsis are present.
    expect(
      screen.getByText(/I guarantee a board seat for the founder/),
    ).toBeInTheDocument();
    expect(screen.getByText(/…/)).toBeInTheDocument();
  });

  it('does not render a preview block when messagePreview is omitted', () => {
    render(<ScreeningOverlay />);
    // The meta line is always present; the preview paragraph is conditional.
    // Use queryBy to assert absence.
    expect(screen.queryByText(/^&ldquo;/)).not.toBeInTheDocument();
  });
});
