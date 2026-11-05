import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NavUser } from '@/lib/navigation/navPolicy';
import { COMPANY_ROLE, FIRM_ROLE } from '@/lib/constants/roles';

const { getNavUserMock, redirectMock } = vi.hoisted(() => ({
  getNavUserMock: vi.fn(),
  redirectMock: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
}));

vi.mock('@/lib/navigation/serverNav', () => ({ getNavUser: getNavUserMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/app/(authed)/leads/page.client', () => ({ default: () => null }));
vi.mock('@/app/(authed)/rail-templates/page.client', () => ({ default: () => null }));

import { outsidePartyPageRedirect } from '@/lib/navigation/navPolicy';
import LeadsPage from '@/app/(authed)/leads/page';
import RailTemplatesPage from '@/app/(authed)/rail-templates/page';

const seller: NavUser = { is_external: true, firm_role: null, company_id: null, company_role: null };
const clientDirector: NavUser = {
  is_external: true,
  firm_role: null,
  company_id: 'co-client',
  company_role: COMPANY_ROLE.DIRECTOR,
};
const clientMember: NavUser = { ...clientDirector, company_role: COMPANY_ROLE.MEMBER };
const banker: NavUser = { is_external: false, firm_role: null, company_id: null, company_role: null };
const externalAdmin: NavUser = { is_external: true, firm_role: FIRM_ROLE.ADMIN, company_id: null, company_role: null };

afterEach(() => {
  vi.clearAllMocks();
});

describe('outsidePartyPageRedirect', () => {
  it('sends a seller or buyer with no company home', () => {
    expect(outsidePartyPageRedirect(seller)).toBe('/projects');
  });

  it('keeps the pages for outside parties who belong to a client company', () => {
    expect(outsidePartyPageRedirect(clientDirector)).toBeNull();
    expect(outsidePartyPageRedirect(clientMember)).toBeNull();
  });

  it('keeps the pages for the bank side and while the profile is unknown', () => {
    expect(outsidePartyPageRedirect(banker)).toBeNull();
    expect(outsidePartyPageRedirect(externalAdmin)).toBeNull();
    expect(outsidePartyPageRedirect(null)).toBeNull();
  });
});

describe.each([
  ['/leads', LeadsPage],
  ['/rail-templates', RailTemplatesPage],
])('%s', (_path, Page) => {
  it('redirects a seller with no company to their home', async () => {
    getNavUserMock.mockResolvedValue(seller);
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT:/projects');
  });

  it('renders for a client company member and for a banker', async () => {
    for (const user of [clientMember, banker]) {
      getNavUserMock.mockResolvedValue(user);
      await expect(Page()).resolves.toBeTruthy();
    }
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
