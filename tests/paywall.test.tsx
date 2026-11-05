import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';

import { PaywallLock } from '../src/components/team/PaywallLock';
import type { Skill } from '../src/lib/api/types';

/*
 * jsdom ships NO `window.matchMedia`, so Framer Motion's
 * `initPrefersReducedMotion()` would fall back to "motion ON" and the
 * AnimatePresence enter/exit would run real animation frames. We stub
 * matchMedia to report reduced-motion — the component's documented
 * reduced-motion contract collapses the entrance to instant, making these
 * behavioral assertions deterministic without depending on frame timing
 * (same precedent as tests/intent.test.tsx).
 */
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Phase F sandbox merge (2026-05-20): Skill.panel renamed to Skill.dataShape
// with domain-name values ('company' / 'cultureFactors' / 'compositeScore').
const samplePremiumSkill: Skill = {
  id: 'synergy-engine',
  name: 'Synergy & Deal-Structuring Engine',
  description: 'Models combined-entity synergies and deal-structure options.',
  category: 'Deal Structuring',
  premium: true,
  dataShape: 'compositeScore',
};

describe('PaywallLock', () => {
  it('renders nothing when skill is null', () => {
    const { container } = render(
      <PaywallLock skill={null} onClose={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the skill name in the headline when a premium skill is set', () => {
    render(<PaywallLock skill={samplePremiumSkill} onClose={() => {}} />);
    const heading = screen.getByRole('heading');
    expect(heading).toHaveTextContent(samplePremiumSkill.name);
    expect(heading).toHaveTextContent('is a Pro skill');
  });

  it('exposes a modal dialog named by its title', () => {
    render(<PaywallLock skill={samplePremiumSkill} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(
      `${samplePremiumSkill.name} is a Pro skill`,
    );
  });

  it('presents an "Upgrade to Pro" control', () => {
    render(<PaywallLock skill={samplePremiumSkill} onClose={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Upgrade to Pro' }),
    ).toBeInTheDocument();
  });

  it('the Upgrade control is inert but gives feedback (no navigation)', () => {
    render(<PaywallLock skill={samplePremiumSkill} onClose={() => {}} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Plan management ships with the next release.',
    );
  });

  it('calls onClose when the close (✕) control is pressed', () => {
    const onClose = vi.fn();
    render(<PaywallLock skill={samplePremiumSkill} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<PaywallLock skill={samplePremiumSkill} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<PaywallLock skill={samplePremiumSkill} onClose={onClose} />);
    // The dialog is the inner card; clicking it must NOT close.
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    // Clicking the backdrop container (parent of the dialog) closes.
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
