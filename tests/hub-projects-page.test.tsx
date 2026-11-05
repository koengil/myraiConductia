import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/*
 * An outside party lands on, and picks from, deal CODE
 * URLs, never the database uuid.
 */

const redirectMock = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirectMock(to) }));
vi.mock('@/lib/flags/isEnabled', () => ({ isEnabled: async () => true }));
vi.mock('@/lib/flags/supabaseSource', () => ({ supabaseFlagSource: {} }));
vi.mock('@/lib/navigation/navPolicy', () => ({ isExternalCompanyDirector: () => false }));
vi.mock('@/lib/navigation/serverNav', () => ({ getNavUser: async () => null }));
vi.mock('@/lib/perspective/serverIdentity', () => ({
  getShellIdentity: async () => ({ isExternal: true, userId: 'u-seller' }),
}));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock('@/components/book/BankHome', () => ({ BankHome: () => null }));
vi.mock('@/components/discovery/ConnectGmailBanner', () => ({ ConnectGmailBanner: () => null }));
vi.mock('@/components/workspace/CommandCenter', () => ({ CommandCenter: () => null }));

type Summary = { id: string; code: string; codename: string; status: string };
let summaries: Summary[] = [];
vi.mock('@/lib/api/v1/access', () => ({
  listMemberDealSummaries: async () => ({ data: summaries, error: null }),
}));

import AuthenticatedHomePage from '../src/app/(authed)/projects/page';

const ATLAS: Summary = { id: '0b5f-uuid-atlas', code: 'ATLAS-2026-001', codename: 'Project Atlas', status: 'active' };
const EMBER: Summary = { id: '6f1c-uuid-ember', code: 'EMBER-2026-002', codename: 'Project Ember', status: 'active' };

afterEach(() => {
  cleanup();
  redirectMock.mockClear();
});

describe('/projects for an outside party', () => {
  it('one deal redirects to its code URL', async () => {
    summaries = [ATLAS];
    await expect(AuthenticatedHomePage()).rejects.toThrow('NEXT_REDIRECT /projects/ATLAS-2026-001');
    expect(redirectMock).toHaveBeenCalledWith('/projects/ATLAS-2026-001');
  });

  it('every picker link uses /projects/<CODE>', async () => {
    summaries = [ATLAS, EMBER];
    render(await AuthenticatedHomePage());
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/projects/ATLAS-2026-001',
      '/projects/EMBER-2026-002',
    ]);
    for (const a of links) expect(a.getAttribute('href')).not.toMatch(/uuid/);
  });
});
