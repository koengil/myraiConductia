import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AppNav, buildAppNavDestinations } from '@/components/shell/AppNav';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import type { NavUser } from '@/lib/navigation/navPolicy';

const { usePathnameMock, useCurrentUserMock } = vi.hoisted(() => ({
  usePathnameMock: vi.fn(),
  useCurrentUserMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/useCurrentUser')>()),
  useCurrentUser: useCurrentUserMock,
}));

const bankMd: NavUser = {
  is_external: false,
  firm_role: FIRM_ROLE.ADMIN,
  company_id: null,
  company_role: null,
};

const readyUserState = {
  status: 'ready' as const,
  data: {
    user: {
      id: 'u-1',
      email: 'md@bank.test',
      full_name: 'Storm Duncan',
      display_name: 'Storm Duncan',
      firm_role: FIRM_ROLE.ADMIN,
      department: null,
      is_external: false,
      status: 'active',
      company_id: 'c-1',
      company_role: COMPANY_ROLE.MEMBER,
      can_invite: true,
    },
    mandate: null,
  },
};

const DEAL_LABELS = [
  'Dashboard',
  'Rails',
  'Team',
  'Mail',
  'Deal Folder',
  'Data Room',
  'Audit Trail',
];

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildAppNavDestinations', () => {
  it('hides per-deal destinations off-deal and keeps the global set', () => {
    const labels = buildAppNavDestinations({
      pathname: '/companies',
      perspective: 'storm',
      dataRoomNav: true,
      navUser: bankMd,
    }).map((item) => item.label);

    // bankMd is a firm admin, so the permissioned AI Costs row joins the set.
    // Organization lives in Settings (avatar menu), never in the bar.
    expect(labels).toEqual(['Conductor Center', 'Leads', 'AI Costs']);
    expect(labels.some((label) => DEAL_LABELS.includes(label))).toBe(false);
    expect(labels).not.toContain('Rails configuration');
  });

  it('gives Discovery a labelled row off-deal for bank-side users when the flag is on', () => {
    const offDeal = (perspective: 'storm' | 'external', discovery: boolean, navUser: NavUser = bankMd) =>
      buildAppNavDestinations({ pathname: '/projects', perspective, dataRoomNav: false, navUser, discovery });

    const on = offDeal('storm', true);
    expect(on.map((item) => item.label)).toEqual(['Conductor Center', 'Leads', 'Discovery', 'AI Costs']);
    expect(on.find((item) => item.label === 'Discovery')?.href).toBe('/discovery');
    expect(offDeal('storm', false).map((item) => item.label)).not.toContain('Discovery');
    expect(
      offDeal('external', true, { ...bankMd, firm_role: null, is_external: true }).map((item) => item.label),
    ).not.toContain('Discovery');
  });

  it('never offers an organization row', () => {
    for (const pathname of ['/projects', '/projects/project-summit/rail', '/settings']) {
      const labels = buildAppNavDestinations({
        pathname,
        perspective: 'storm',
        dataRoomNav: true,
        navUser: bankMd,
        discovery: true,
      }).map((item) => item.label);
      expect(labels).not.toContain('My organization');
      expect(labels).not.toContain('Employees');
    }
  });

  it('shows Rails configuration off-deal only with the template permission', () => {
    const labels = buildAppNavDestinations({
      pathname: '/companies',
      perspective: 'storm',
      dataRoomNav: true,
      navUser: {
        ...bankMd,
        companyPermissionKeys: new Set([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
      },
    }).map((item) => item.label);

    expect(labels).toContain('Rails configuration');
  });

  it('adds AI Costs to the global set for firm overseers only, matching TopNav', () => {
    const banker = buildAppNavDestinations({
      pathname: '/projects',
      perspective: 'storm',
      dataRoomNav: true,
      navUser: { ...bankMd, firm_role: null, company_role: 'member' },
    });
    expect(banker.map((item) => item.label)).not.toContain('AI Costs');

    const items = buildAppNavDestinations({
      pathname: '/ai-costs',
      perspective: 'storm',
      dataRoomNav: true,
      navUser: { ...bankMd, firm_role: null, company_role: 'director' },
    });
    expect(items.map((item) => item.label)).toEqual(['Conductor Center', 'Leads', 'AI Costs']);
    expect(items.find((item) => item.label === 'AI Costs')?.href).toBe('/ai-costs');
  });

  it('keeps AI Costs in the bar on a deal for firm overseers, as the desktop nav does', () => {
    const onDeal = (navUser: NavUser) =>
      buildAppNavDestinations({ pathname: '/projects/project-summit/rail', perspective: 'storm', navUser, dataRoomNav: true }).map(
        (item) => item.label,
      );
    expect(onDeal({ ...bankMd, firm_role: null, company_role: 'director' })).toContain('AI Costs');
    expect(onDeal({ ...bankMd, firm_role: null, company_role: 'member' })).not.toContain('AI Costs');
  });

  it('treats the Command Center picker and profile as off-deal', () => {
    for (const pathname of ['/projects', '/profile', '/leads']) {
      const labels = buildAppNavDestinations({
        pathname,
        perspective: 'storm',
        dataRoomNav: true,
        navUser: bankMd,
      }).map((item) => item.label);
      expect(labels).not.toContain('Rails');
      expect(labels).not.toContain('Deal Folder');
      expect(labels).toContain('Conductor Center');
    }
  });

  it('binds per-deal destinations to the URL deal once one is open', () => {
    const items = buildAppNavDestinations({
      pathname: '/projects/PALET-2026-497/rail',
      perspective: 'storm',
      dataRoomNav: true,
      navUser: bankMd,
    });

    // bankMd is a firm admin, so the permissioned AI Costs row follows the deal's own.
    expect(items.map((item) => item.label)).toEqual(['Conductor Center', ...DEAL_LABELS, 'AI Costs']);
    expect(items.find((item) => item.label === 'Rails')?.href).toBe(
      '/projects/PALET-2026-497/rail',
    );
    expect(items.find((item) => item.label === 'Dashboard')?.href).toBe(
      '/projects/PALET-2026-497',
    );
  });

  it('omits Data Room on a deal while deal_data_room_nav is off, and lists it when on', () => {
    const onDeal = (dataRoomNav: boolean) =>
      buildAppNavDestinations({
        pathname: '/projects/PALET-2026-497/rail',
        perspective: 'storm',
        navUser: bankMd,
        dataRoomNav,
      }).map((item) => item.label);

    const off = onDeal(false);
    expect(off).not.toContain('Data Room');
    expect(off).toContain('Deal Folder');
    expect(off).toEqual(['Conductor Center', ...DEAL_LABELS.filter((l) => l !== 'Data Room'), 'AI Costs']);
    expect(onDeal(true)).toEqual(['Conductor Center', ...DEAL_LABELS, 'AI Costs']);
  });

  it('keeps Data Room for external seats with the flag off', () => {
    const labels = buildAppNavDestinations({
      pathname: '/projects/PALET-2026-497/rail',
      perspective: 'external',
      navUser: { ...bankMd, is_external: true, firm_role: null },
      dataRoomNav: false,
    }).map((item) => item.label);

    expect(labels).toContain('Data Room');
  });

  it('never falls back to the sandbox default deal off-deal', () => {
    const hrefs = buildAppNavDestinations({
      pathname: '/companies',
      perspective: 'storm',
      dataRoomNav: true,
      navUser: bankMd,
    }).map((item) => item.href);

    expect(hrefs.some((href) => href.includes('project-summit'))).toBe(false);
  });
});

describe('AppNav bottom bar', () => {
  it('does not render deal destinations off-deal', () => {
    usePathnameMock.mockReturnValue('/leads');
    useCurrentUserMock.mockReturnValue({ state: readyUserState });

    render(<AppNav layout="bottom-bar" perspective="storm" />);

    expect(screen.getByRole('link', { name: 'Conductor Center' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.getByRole('link', { name: 'Leads' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Rails' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Deal Folder' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Data Room' })).not.toBeInTheDocument();
  });

  it('renders deal destinations once a deal is open', () => {
    usePathnameMock.mockReturnValue('/projects/PALET-2026-497/rail');
    useCurrentUserMock.mockReturnValue({ state: readyUserState });

    render(<AppNav layout="bottom-bar" perspective="storm" />);

    expect(screen.getByRole('link', { name: 'Rails' })).toHaveAttribute(
      'href',
      '/projects/PALET-2026-497/rail',
    );
    expect(screen.getByRole('link', { name: 'Rails' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Deal Folder' })).toBeInTheDocument();
    // Provider-less useFlag is fail-closed, so deal_data_room_nav is off.
    expect(screen.queryByRole('link', { name: 'Data Room' })).not.toBeInTheDocument();
  });
});
