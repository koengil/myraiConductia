import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import * as React from 'react';

import SynergyStressTestPanel from '../src/components/acquirers/SynergyStressTestPanel';

/*
 * SynergyStressTestPanel — Phase D of the sandbox merge.
 *
 * Hits the live `getSynergyStressTest` seam method on the mock API (the
 * same path production code takes). Asserts the eyebrow + display title,
 * each of the three row labels, at least one base-rate string from the
 * fixture, and the long-form risk note. Zero `console.error` on the happy
 * path — silence-the-console contract.
 */

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  errorSpy.mockRestore();
});

describe('SynergyStressTestPanel', () => {
  it('renders eyebrow, title, all three row labels, a base-rate string, and the risk note', async () => {
    render(<SynergyStressTestPanel acquirerId="anthropic" />);

    expect(
      await screen.findByText('Management case vs. base rates'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Synergy stress-test'),
    ).toBeInTheDocument();

    expect(await screen.findByText('Cost synergies')).toBeInTheDocument();
    expect(await screen.findByText('Revenue synergies')).toBeInTheDocument();
    expect(
      await screen.findByText('Total announced to captured'),
    ).toBeInTheDocument();

    // At least one of the fixture base-rate strings is on screen.
    expect(
      await screen.findByText('30–50% within 2 yrs'),
    ).toBeInTheDocument();

    // Long-form risk note (substring match — the full paragraph is too long
    // to assert verbatim and small copy edits shouldn't break the contract).
    const riskParagraph = await screen.findByText(
      /remote-first|Salesforce/,
    );
    expect(riskParagraph).toBeInTheDocument();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});
