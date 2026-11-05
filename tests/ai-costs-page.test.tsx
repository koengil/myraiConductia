import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { NavUser } from '@/lib/navigation/navPolicy';

const { getNavUserMock, redirectMock } = vi.hoisted(() => ({
  getNavUserMock: vi.fn(),
  redirectMock: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
}));

vi.mock('@/lib/navigation/serverNav', () => ({ getNavUser: getNavUserMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import AiCostsPage from '@/app/(authed)/ai-costs/page';

const director: NavUser = { is_external: false, firm_role: null, company_id: 'c-1', company_role: 'director' };
const banker: NavUser = { is_external: false, firm_role: null, company_id: 'c-1', company_role: 'member' };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('/ai-costs', () => {
  it('renders the firm AI spend, open, for a firm overseer', async () => {
    getNavUserMock.mockResolvedValue(director);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ summary: { totalCostUsd: 0, calls: 0, unpricedCalls: 0, byDeal: [], byPerson: [], byTask: [], byModel: [] } }),
    })));

    render(await AiCostsPage());

    expect(screen.getByRole('heading', { level: 1, name: 'AI costs' })).toBeInTheDocument();
    const panel = await screen.findByLabelText('Firm AI spend');
    expect(panel).toHaveAttribute('open');
    expect(fetch).toHaveBeenCalledWith('/api/v1/ai-spend', expect.objectContaining({ credentials: 'include' }));
  });

  it('sends everyone else home', async () => {
    getNavUserMock.mockResolvedValue(banker);
    await expect(AiCostsPage()).rejects.toThrow('NEXT_REDIRECT:/projects');

    getNavUserMock.mockResolvedValue(null);
    await expect(AiCostsPage()).rejects.toThrow('NEXT_REDIRECT:/projects');
  });
});
