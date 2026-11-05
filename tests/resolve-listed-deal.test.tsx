import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({ deals: [] as unknown[], loading: false }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'SUMMIT-2026-003' }),
  usePathname: () => '/projects/SUMMIT-2026-003/rail',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => key === 'platform_onboarding',
}));
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return { ...actual, useDeals: () => ({ deals: state.deals, loading: state.loading, error: null, reload: vi.fn() }) };
});
vi.mock('@/lib/rail/projectRail', () => ({ useProjectRail: () => ({ rail: null }) }));
vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: () => ({ state: { status: 'loading' } }) }));

import { DealContextBar } from '@/components/shell/DealContextBar';
import { resolveListedDeal } from '@/lib/deals/useDeals';

afterEach(() => cleanup());

const api = { apiEnabled: true, fixtureFallback: false };
const mine = { id: 'ATLAS-2026-001', code: 'ATLAS-2026-001', codename: 'Project Atlas' };

describe('resolveListedDeal', () => {
  it('finds a listed deal and never returns the pending placeholder', () => {
    expect(resolveListedDeal('ATLAS-2026-001', [mine] as never, api)?.codename).toBe('Project Atlas');
    expect(resolveListedDeal('SUMMIT-2026-003', [mine] as never, api)).toBeNull();
  });
});

describe('DealContextBar for a deal the viewer is not on', () => {
  it('says "Select a deal", never the raw code', () => {
    state.deals = [mine];
    render(<DealContextBar />);
    expect(screen.getByRole('button', { name: 'Select a deal' })).toHaveTextContent('Select a deal');
    expect(screen.queryByText('SUMMIT-2026-003')).toBeNull();
  });
});
