import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { TopNav } from '@/components/organisms/navigation';
import { perDealNavItems } from '@/components/organisms/navigation/perDealNav';
import { AppNav, buildAppNavDestinations, splitPhoneBar } from '@/components/shell/AppNav';
import { showLeadsNav, showRailsNav, type NavUser } from '@/lib/navigation/navPolicy';
import { SessionProvider } from '../src/lib/session/store';

/*
 * The outside-party nav: no Rails (the rail is bank-internal) and no
 * Leads for a seat with no company (the server refuses their request).
 * Also the deal switcher's full-name title and width cap, and the
 * phone bar's More showing where you are.
 */

const { usePathnameMock, useDealsMock, userOverrides } = vi.hoisted(() => ({
  usePathnameMock: vi.fn(),
  useDealsMock: vi.fn(),
  userOverrides: { current: {} as Record<string, unknown> },
}));

vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: () => false }));
vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/useCurrentUser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/useCurrentUser')>();
  return {
    ...actual,
    useCurrentUser: () => ({
      state: {
        status: 'ready',
        data: {
          user: {
            id: 'u-1',
            email: 'md@bank.test',
            full_name: 'Storm Duncan',
            display_name: 'Storm Duncan',
            firm_role: null,
            department: null,
            is_external: false,
            status: 'active',
            company_id: 'c-1',
            company_role: 'director',
            can_invite: true,
            ...userOverrides.current,
          },
          mandate: null,
        },
      },
    }),
  };
});
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return { ...actual, useDeals: useDealsMock };
});
vi.mock('@/lib/notifications/useNotifications', () => ({
  useNotifications: () => ({ items: [], unread: 0, ready: true, markRead: vi.fn(), reload: vi.fn() }),
}));

const LONG_CODENAME = 'Project Extraordinarily Long Codename';
const deal = {
  id: 'ATLAS-2026-001',
  codename: LONG_CODENAME,
  code: 'ATLAS-2026-001',
  target: 'Atlassian',
  sector: 'Software',
  status: 'Execution',
  cursorStepId: 'p2-s26',
  entryStepSeq: 1,
  gate0Complete: true,
  dealRole: 'Lead Banker',
};

const SELLER = { id: 'u-seller', full_name: 'Mike Cannon-Brookes', display_name: null, is_external: true, company_id: null, company_role: null };

function renderTopNav(pathname: string, perspective: 'storm' | 'external') {
  usePathnameMock.mockReturnValue(pathname);
  return render(
    <SessionProvider>
      <TopNav perspective={perspective} />
    </SessionProvider>,
  );
}

function renderBar(pathname: string, perspective: 'storm' | 'external') {
  usePathnameMock.mockReturnValue(pathname);
  return render(
    <SessionProvider>
      <AppNav layout="bottom-bar" perspective={perspective} />
    </SessionProvider>,
  );
}

beforeEach(() => {
  useDealsMock.mockReturnValue({ deals: [deal] });
});

afterEach(() => {
  vi.clearAllMocks();
  userOverrides.current = {};
});

const bankMd: NavUser = { is_external: false, firm_role: null, company_id: 'bank', company_role: 'director' };
const seller: NavUser = { is_external: true, firm_role: null, company_id: null, company_role: null };
const clientDirector: NavUser = { is_external: true, firm_role: null, company_id: 'client', company_role: 'director' };

describe('navPolicy', () => {
  it('shows Rails to the bank and not to outside parties', () => {
    expect(showRailsNav('storm')).toBe(true);
    expect(showRailsNav('external')).toBe(false);
  });

  it('shows Leads to the bank, and to an outside party only with a company', () => {
    expect(showLeadsNav(bankMd)).toBe(true);
    expect(showLeadsNav(seller)).toBe(false);
    expect(showLeadsNav({ ...seller, company_role: null })).toBe(false);
    expect(showLeadsNav(clientDirector)).toBe(true);
  });

  it('the per-deal list and the phone list drop Rails for outside parties only', () => {
    expect(perDealNavItems('external').map((i) => i.id)).not.toContain('rail');
    expect(perDealNavItems('storm').map((i) => i.id)[0]).toBe('rail');
    const ids = (perspective: 'storm' | 'external') =>
      buildAppNavDestinations({ pathname: '/projects/X/team', perspective, navUser: null, dataRoomNav: false }).map((d) => d.id);
    expect(ids('external')).not.toContain('rail');
    expect(ids('storm')).toContain('rail');
  });
});

describe('TopNav for an outside party', () => {
  it('has no Rails and no Leads on a deal for a seller', () => {
    userOverrides.current = SELLER;
    renderTopNav('/projects/ATLAS-2026-001/team', 'external');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).queryByRole('link', { name: 'Rails' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Leads' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Team' })).toBeInTheDocument();
  });

  it('keeps Rails and Leads for Storm', () => {
    renderTopNav('/projects/ATLAS-2026-001/team', 'storm');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByRole('link', { name: 'Rails' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Leads' })).toBeInTheDocument();
  });
});

describe('phone bar for an outside party', () => {
  it('has no Rails for a seller, on a deal and off it', () => {
    userOverrides.current = SELLER;
    const on = renderBar('/projects/ATLAS-2026-001/team', 'external');
    expect(screen.queryByRole('link', { name: 'Rails' })).toBeNull();
    on.unmount();
    renderBar('/projects', 'external');
    expect(screen.queryByRole('link', { name: 'Leads' })).toBeNull();
  });

  it('keeps Rails for Storm', () => {
    renderBar('/projects/ATLAS-2026-001/team', 'storm');
    expect(screen.getByRole('link', { name: 'Rails' })).toBeInTheDocument();
  });
});

describe("an outside party's phone bar on a deal is pinned", () => {
  const split = (dataRoomNav: boolean) => {
    const entries = [
      ...buildAppNavDestinations({ pathname: '/projects/X/team', perspective: 'external', navUser: seller, dataRoomNav }),
      { id: 'settings' },
    ];
    const { primary, more } = splitPhoneBar(entries, true);
    return { primary: primary.map((e) => e.id), more: more.map((e) => e.id) };
  };

  it('is Conductor, Team, Mail, Dashboard, Data Room, then More: Audit Trail, Settings', () => {
    expect(split(true)).toEqual({
      primary: ['command-center', 'team', 'mail', 'mandate', 'dataRoom'],
      more: ['audit', 'settings'],
    });
    // Outside parties always keep the Data Room, whatever the internal flag says.
    expect(split(false)).toEqual(split(true));
  });
});

describe('the deal switcher and More', () => {
  it('titles a truncated codename with the full name and caps its width on a phone', () => {
    renderTopNav('/projects/ATLAS-2026-001/team', 'storm');
    const label = screen.getByText(LONG_CODENAME);
    expect(label).toHaveAttribute('title', LONG_CODENAME);
    expect(label.className).toContain('truncate');
    expect(label.className).toMatch(/(^| )max-w-\[\d+px\]/);
    expect(label.className).toContain('sm:max-w-[140px]');
  });

  it('marks More as where you are when the page is one it holds', () => {
    renderBar('/projects/ATLAS-2026-001/audit', 'storm');
    const cell = screen.getByRole('button', { name: 'More' }).closest('li');
    expect(cell).toHaveAttribute('data-active', 'true');
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('leaves More plain on a page in the bar', () => {
    renderBar('/projects/ATLAS-2026-001/team', 'storm');
    expect(screen.getByRole('button', { name: 'More' }).closest('li')).not.toHaveAttribute('data-active');
  });
});
