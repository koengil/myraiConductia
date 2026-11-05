import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { StepRunner } from '@/components/rail/StepRunner';
import { TeaserRunner } from '@/components/rail/TeaserRunner';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { TEASER_STEP_ID } from '@/lib/rail/dealRail';
import { catalogFor, type ProjectRailStep } from '@/lib/rail/projectRail';
import { SessionProvider } from '@/lib/session/store';

vi.mock('@/components/rail/SkillStepRunner', () => ({
  SkillStepRunner: () => <p>Bound skill runner</p>,
}));

vi.mock('@/lib/deals/useDeals', () => ({
  useActiveDeal: () => ({ codename: 'Project Ridge' }),
}));

const TEASER_PROJECT_STEP: ProjectRailStep = {
  id: '5d1c8f0e-36aa-4c36-9f36-363636363636',
  stepId: TEASER_STEP_ID,
  origin: 'catalog',
  phaseIndex: 1,
  displayOrder: 31,
  seq: 36,
  status: 'current',
  definition: null,
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
};

function flags(sandboxTeaser: boolean): FlagMap {
  const off = Object.fromEntries(
    Object.keys(FLAG_REGISTRY).map((key) => [key, false]),
  ) as Record<FlagKey, boolean>;
  return { ...off, teaser_sandbox_runner: sandboxTeaser };
}

function renderTeaserStep(sandboxTeaser: boolean) {
  const step = catalogFor(TEASER_STEP_ID);
  if (!step) throw new Error('the catalogue has no Teaser station');
  render(
    <FlagsProvider value={flags(sandboxTeaser)}>
      <SessionProvider>
        <StepRunner
          step={step}
          projectStep={TEASER_PROJECT_STEP}
          dealId="RIDGE-2026-004"
          onClose={() => {}}
        />
      </SessionProvider>
    </FlagsProvider>,
  );
}

describe('the Teaser station', () => {
  it('runs its bound skill, never the sandbox teaser, while teaser_sandbox_runner is off', () => {
    renderTeaserStep(false);

    expect(screen.getByText('Bound skill runner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft the teaser' })).not.toBeInTheDocument();
  });

  it('runs the sandbox teaser when teaser_sandbox_runner is on', () => {
    renderTeaserStep(true);

    expect(screen.getByRole('button', { name: 'Draft the teaser' })).toBeInTheDocument();
    expect(screen.queryByText('Bound skill runner')).not.toBeInTheDocument();
  });
});

describe('TeaserRunner', () => {
  it('drafts and screens the teaser once the plan is confirmed, then waits for the sign-off', async () => {
    render(
      <SessionProvider>
        <TeaserRunner />
      </SessionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Draft the teaser' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm plan' }));

    expect(
      await screen.findByRole('button', { name: 'Sign off & clear to send' }),
    ).toBeEnabled();
    expect(screen.getByText(/Confidential Teaser/)).toBeInTheDocument();
    // The draft clears compliance: clean by default, still screened.
    expect(screen.getByText('Compliance: Cleared')).toBeInTheDocument();
  });

  it('drafts a clean teaser by default, says what happens in one plain line, and offers no scenario picker', () => {
    render(
      <SessionProvider>
        <TeaserRunner />
      </SessionProvider>,
    );

    expect(
      screen.getByText('Conductia drafts the teaser. You review and sign off.'),
    ).toBeInTheDocument();
    for (const gone of [
      'Clean teaser',
      'Contains an internal valuation',
      'Promissory language',
      'Live agent step · orchestration spine',
    ]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    expect(document.body.textContent).not.toMatch(/orchestration|spine/i);
  });

  it('writes the teaser headline without an em dash', async () => {
    render(
      <SessionProvider>
        <TeaserRunner />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Draft the teaser' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm plan' }));
    const headline = await screen.findByText(/Confidential Teaser/);
    expect(headline.textContent).not.toContain('\u2014');
    expect(document.body.textContent).not.toContain('\u2014');
  });

  it('writes the audit trail in plain words, never the workflow codes', async () => {
    render(
      <SessionProvider>
        <TeaserRunner />
      </SessionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Draft the teaser' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm plan' }));
    await screen.findByRole('button', { name: 'Sign off & clear to send' });

    const trail = screen.getByText(/^Audit trail/).closest('details') as HTMLElement;
    const lines = Array.from(trail.querySelectorAll('li')).map((li) => li.textContent ?? '');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Waiting for you · Plan ready. Waiting for you to confirm.'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toMatch(/[A-Z]{2,}_[A-Z_]+|\u2014|orchestrat|spine/);
    }
  });
});
