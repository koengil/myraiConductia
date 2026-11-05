import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { TopNav } from '@/components/organisms/navigation';
import { SessionProvider } from '../src/lib/session/store';

const { usePathnameMock, useDealsMock, userOverrides, flagOverrides } = vi.hoisted(() => ({
  usePathnameMock: vi.fn(),
  useDealsMock: vi.fn(),
  userOverrides: { current: {} as Record<string, unknown> },
  flagOverrides: { current: {} as Record<string, boolean> },
}));

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => flagOverrides.current[key] === true,
}));
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
            company_role: null,
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
  useNotifications: () => ({
    items: [],
    unread: 0,
    ready: true,
    markRead: vi.fn(),
    reload: vi.fn(),
  }),
}));

const seedDeal = {
  id: 'project-summit',
  codename: 'Project Summit',
  code: 'SUM-2026-001',
  target: 'Atlassian',
  sector: 'Software',
  status: 'Execution',
  cursorStepId: 'p2-s26',
  entryStepSeq: 1,
  gate0Complete: true,
  dealRole: 'Lead Banker',
};

function renderTopNav(pathname: string) {
  usePathnameMock.mockReturnValue(pathname);
  return render(
    <SessionProvider>
      <TopNav />
    </SessionProvider>,
  );
}

beforeEach(() => {
  useDealsMock.mockReturnValue({ deals: [seedDeal] });
});

afterEach(() => {
  vi.clearAllMocks();
  flagOverrides.current = {};
  userOverrides.current = {};
});

describe('TopNav (workbench_top_nav shell)', () => {
  it('renders the per-deal destinations with their frozen accessible names', () => {
    flagOverrides.current = { deal_data_room_nav: true };
    renderTopNav('/projects/project-summit/rail');

    for (const label of ['Rails', 'Team', 'Mail', 'Deal Folder', 'Data Room', 'Audit Trail']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Rails' })).toHaveAttribute('aria-current', 'page');
    // Skills stays out of the top nav until the marketplace ships.
    expect(screen.queryByRole('link', { name: 'Skills' })).not.toBeInTheDocument();
  });

  it('lists Deal Folder and no Data Room while deal_data_room_nav is off', () => {
    renderTopNav('/projects/project-summit/rail');

    expect(screen.getByRole('link', { name: 'Deal Folder' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Data Room' })).not.toBeInTheDocument();
  });
  it('hides the per-deal destinations off-deal and keeps the global ones', () => {
    renderTopNav('/projects');

    expect(screen.queryByRole('link', { name: 'Rails' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Conductor Center' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Leads' })).toBeInTheDocument();
  });

  it('shows the AI Costs pill only to firm overseers', () => {
    const md = renderTopNav('/projects');
    expect(screen.queryByRole('link', { name: 'AI Costs' })).not.toBeInTheDocument();
    md.unmount();

    userOverrides.current = { company_role: 'director' };
    renderTopNav('/ai-costs');
    const link = screen.getByRole('link', { name: 'AI Costs' });
    expect(link).toHaveAttribute('href', '/ai-costs');
    expect(link).toHaveAttribute('aria-current', 'page');
    userOverrides.current = {};
  });

  it('makes the brand mark a link home, named apart from Conductor Center', () => {
    renderTopNav('/projects/project-summit/rail');

    expect(screen.getByRole('link', { name: 'Conductia home' })).toHaveAttribute('href', '/projects');
    expect(screen.getAllByRole('link', { name: 'Conductor Center' })).toHaveLength(1);
  });

  it('shows the global pill names off-deal and keeps Leads and Discovery named with a deal open', async () => {
    flagOverrides.current = { deal_discovery: true };
    userOverrides.current = { firm_role: 'admin' };
    const labelClass = (name: string) =>
      screen.getByRole('link', { name }).querySelector('span')?.className ?? '';

    // Off-deal the global pills are the whole row: names from lg up, no More menu.
    const offDeal = renderTopNav('/projects');
    for (const name of ['Conductor Center', 'Leads', 'Discovery', 'AI Costs']) {
      expect(labelClass(name)).toContain('lg:inline');
    }
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    offDeal.unmount();

    // With a deal open they follow six per-deal pills. Leads and Discovery keep
    // their names from xl (1280px laptops); the other global destinations fold
    // into More below 2xl and return as pills from 2xl.
    renderTopNav('/projects/project-summit/rail');
    expect(labelClass('Leads')).toContain('xl:inline');
    expect(labelClass('Leads')).not.toContain('2xl:inline');
    expect(labelClass('Discovery')).toContain('xl:inline');
    const homePill = screen.getByRole('link', { name: 'Conductor Center' });
    expect(homePill.closest('li')?.className).toContain('2xl:block');
    expect(homePill.closest('li')?.className).toContain('hidden');

    const more = screen.getByRole('button', { name: 'More' });
    expect(more.closest('li')?.className).toContain('2xl:hidden');
    fireEvent.keyDown(more, { key: 'Enter' });
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Conductor Center', 'AI Costs']);
  });

  it('has no organization pill: Organization lives in Settings', () => {
    for (const path of ['/projects', '/projects/project-summit/rail']) {
      const view = renderTopNav(path);
      expect(screen.queryByRole('link', { name: 'My organization' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('adds Organization to the avatar menu for directors and firm admins only', () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ company_role: 'member' }, false],
      [{ company_role: null }, false],
      [{ firm_role: 'cco', company_role: 'member' }, false],
      [{ company_role: 'director' }, true],
      [{ firm_role: 'admin', company_role: null }, true],
      [{ company_role: 'director', is_external: true }, true],
      // Settings › Organization needs a company, so there is nothing to link to.
      [{ firm_role: 'admin', company_id: null }, false],
    ];
    for (const [overrides, shown] of cases) {
      userOverrides.current = overrides;
      const view = renderTopNav('/projects');
      fireEvent.click(screen.getByRole('button', { name: /open profile menu/ }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
      const link = within(dialog).queryByRole('link', { name: 'Organization' });
      if (shown) {
        expect(link, JSON.stringify(overrides)).toHaveAttribute('href', '/settings?section=organization');
      } else {
        expect(link, JSON.stringify(overrides)).toBeNull();
      }
      view.unmount();
    }
  });

  it('mounts exactly one compliance instrument, and only on project routes', () => {
    const { container, unmount } = renderTopNav('/projects/project-summit/rail');
    expect(container.querySelectorAll('[data-compliance-status]')).toHaveLength(1);
    unmount();

    const offDeal = renderTopNav('/projects');
    expect(offDeal.container.querySelectorAll('[data-compliance-status]')).toHaveLength(0);
  });

  it('renders top chrome only — no sidebar rail in the tree', () => {
    const { container } = renderTopNav('/projects/project-summit/rail');
    expect(container.querySelector('header')).toBeInTheDocument();
    expect(container.querySelector('aside')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deal: Project Summit/ })).toBeInTheDocument();
  });

  it('names the deal by code name only in the switcher; the code is not on the trigger', () => {
    renderTopNav('/projects/project-summit/rail');
    const switcher = screen.getByRole('button', { name: /Deal: Project Summit/ });
    expect(switcher).toHaveTextContent('Project Summit');
    expect(switcher.textContent).not.toContain('SUM-2026-001');
  });

  it('shows "Select a deal", never the raw code, for a deal the viewer is not on', () => {
    // The raw code came from the pending-deal tier, which runs only when the deal API is on.
    flagOverrides.current = { platform_onboarding: true };
    useDealsMock.mockReturnValue({ deals: [seedDeal], loading: false });
    renderTopNav('/projects/SUMMIT-2026-003/rail');
    const switcher = screen.getByRole('button', { name: 'Select a deal' });
    expect(switcher).toHaveTextContent('Select a deal');
    expect(screen.queryByText('SUMMIT-2026-003')).not.toBeInTheDocument();
  });
});
