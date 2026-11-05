import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import type { ListedDeal } from '../src/lib/deals/useDeals';

/*
 * The deal home's next move is the deal's real
 * current step from the deal list, never the seam mock's "Compose the pitch ·
 * Final step" for a "New mandate". Vitals with no analysis behind them
 * ("Pipeline 0", "Team 0") are not shown.
 */

let projectId = 'SUMMIT-2026-003';
vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId }),
}));

let activeDeal: ListedDeal;
vi.mock('@/lib/deals/useDeals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/deals/useDeals')>()),
  useResolvedDeal: () => ({ status: 'ready', deal: activeDeal }),
}));
vi.mock('@/lib/rail/projectRail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/rail/projectRail')>()),
  useProjectRail: () => ({ rail: null }),
}));

import { ProjectDashboard } from '../src/components/workspace/ProjectDashboard';

const SUMMIT = {
  id: 'SUMMIT-2026-003',
  uuid: '7d1f0000-0000-4000-8000-000000000003',
  codename: 'Project Summit',
  code: 'SUMMIT-2026-003',
  target: 'Project Summit',
  sector: '',
  status: 'Origination, Qualification & Mandate',
  cursorStepId: 'p1-s12',
  entryStepSeq: 1,
  gate0Complete: true,
  dealRole: 'md',
  currentStep: { stepId: 'p1-s12', seq: 12, phaseIndex: 1, title: 'Client NDA Workflow' },
} as unknown as ListedDeal;

afterEach(() => {
  cleanup();
});

describe('ProjectDashboard next move', () => {
  it('names the real current step and links to it on the rail', async () => {
    activeDeal = SUMMIT;
    projectId = 'SUMMIT-2026-003';
    render(<ProjectDashboard />);
    const link = await screen.findByRole('link', { name: 'Open current step: Client NDA Workflow' });
    expect(link).toHaveAttribute('href', '/projects/SUMMIT-2026-003/rail?step=12');
    const text = document.body.textContent ?? '';
    for (const gone of ['Compose the pitch', 'Final step', 'New mandate']) expect(text, gone).not.toContain(gone);
  });

  it('shows no vitals when the deal has no analysis behind them', async () => {
    activeDeal = SUMMIT;
    projectId = 'SUMMIT-2026-003';
    render(<ProjectDashboard />);
    await screen.findByRole('link', { name: /Open current step/ });
    expect(screen.queryByLabelText('Mandate vitals')).toBeNull();
    expect(screen.queryByText('Advisors cleared')).toBeNull();
  });

  it('a deal with no active step offers no next move', async () => {
    activeDeal = { ...SUMMIT, currentStep: null } as unknown as ListedDeal;
    projectId = 'SUMMIT-2026-003';
    render(<ProjectDashboard />);
    await screen.findByRole('heading', { name: 'Project Summit' });
    expect(screen.queryByRole('link', { name: /Open current step/ })).toBeNull();
  });
});
