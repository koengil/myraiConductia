import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/organisms/navigation/Sidebar';

const { usePathnameMock, useDealsMock, useCurrentUserMock, flagOverrides } = vi.hoisted(() => ({
  usePathnameMock: vi.fn(),
  useDealsMock: vi.fn(),
  useCurrentUserMock: vi.fn(),
  flagOverrides: { current: {} as Record<string, boolean> },
}));

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => flagOverrides.current[key] === true,
}));
vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
const readyUserState = {
  status: 'ready' as const,
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
    },
    mandate: null,
  },
};

vi.mock('@/lib/auth/useCurrentUser', () => ({
  initialsFor: () => 'SD',
  initialsFromEmail: () => 'SD',
  useCurrentUser: useCurrentUserMock,
}));
vi.mock('@/lib/auth/useProfilePhoto', () => ({
  useProfilePhoto: () => ({ photoUrl: null }),
}));
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return {
    ...actual,
    useDeals: useDealsMock,
  };
});
vi.mock('@/lib/rail/gate0', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rail/gate0')>();
  return { ...actual, GATE0_MODAL_ENTRY_ENABLED: false };
});
vi.mock('@/components/deals/DealSelect', () => ({ SidebarDealSelect: () => null }));
vi.mock('@/components/wizard/NewMandateDialog', () => ({ NewMandateDialog: () => null }));

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

beforeEach(() => {
  useDealsMock.mockReturnValue({ deals: [seedDeal] });
  useCurrentUserMock.mockReturnValue({ state: readyUserState });
});

afterEach(() => {
  vi.clearAllMocks();
  flagOverrides.current = {};
});

describe('Sidebar AI costs row', () => {
  it('links firm overseers to the AI costs page and marks it active there', () => {
    usePathnameMock.mockReturnValue('/ai-costs');
    useCurrentUserMock.mockReturnValue({
      state: { ...readyUserState, data: { ...readyUserState.data, user: { ...readyUserState.data.user, company_role: 'director' } } },
    });

    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="storm" />);

    const link = screen.getByRole('link', { name: 'AI Costs' });
    expect(link).toHaveAttribute('href', '/ai-costs');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('hides the row from a banker without the full spend breakdown', () => {
    usePathnameMock.mockReturnValue('/projects');
    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="storm" />);
    expect(screen.queryByRole('link', { name: 'AI Costs' })).not.toBeInTheDocument();
  });
});

describe('Sidebar per-deal navigation', () => {
  it('keeps conductor center, leads, and Settings visible while the profile loads', () => {
    usePathnameMock.mockReturnValue('/projects');
    useCurrentUserMock.mockReturnValue({ state: { status: 'loading', email: null } });

    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="storm" />);

    expect(screen.getByRole('link', { name: 'Conductor Center' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(screen.getByRole('link', { name: 'Leads' })).toHaveAttribute('href', '/leads');
    expect(screen.queryByRole('link', { name: 'My organization' })).not.toBeInTheDocument();
    // One way into Settings from the footer; the identity row is not a second link.
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('link', { name: 'Open profile page' })).not.toBeInTheDocument();
  });

  it('hides deal subsections on the Command Center when no deal is selected', () => {
    usePathnameMock.mockReturnValue('/projects');

    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="storm" />);

    expect(screen.queryByRole('link', { name: 'Rails' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument();
  });

  it('shows deal subsections once a deal is selected', () => {
    usePathnameMock.mockReturnValue('/projects/PALET-2026-497/rail');
    useDealsMock.mockReturnValue({
      deals: [
        {
          ...seedDeal,
          id: 'project-palette',
          codename: 'Project Palette',
          code: 'PALET-2026-497',
        },
      ],
    });

    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="storm" />);

    expect(screen.getByRole('link', { name: 'Rails' })).toHaveAttribute(
      'href',
      '/projects/PALET-2026-497/rail',
    );
    expect(screen.getByRole('link', { name: 'Team' })).toHaveAttribute(
      'href',
      '/projects/PALET-2026-497/team',
    );
  });

  it('shows Mail and Audit, and no Rails, for external users when a deal is open', () => {
    usePathnameMock.mockReturnValue('/projects/PALET-2026-497/team');
    useDealsMock.mockReturnValue({
      deals: [
        {
          ...seedDeal,
          id: 'PALET-2026-497',
          codename: 'Project Palette',
          code: 'PALET-2026-497',
        },
      ],
    });

    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="external" />);

    // The rail is bank-internal: outside parties get no Rails row.
    expect(screen.queryByRole('link', { name: 'Rails' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mail' })).toHaveAttribute(
      'href',
      '/projects/PALET-2026-497/mail',
    );
    expect(screen.getByRole('link', { name: 'Audit Trail' })).toHaveAttribute(
      'href',
      '/projects/PALET-2026-497/audit',
    );
  });
});

describe('Sidebar Data Room row (deal_data_room_nav)', () => {
  const openDeal = () => {
    usePathnameMock.mockReturnValue('/projects/PALET-2026-497/rail');
    useDealsMock.mockReturnValue({
      deals: [{ ...seedDeal, id: 'project-palette', code: 'PALET-2026-497' }],
    });
  };

  it('lists Deal Folder and no Data Room for internal users while the flag is off', () => {
    openDeal();
    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="storm" />);

    expect(screen.getByRole('link', { name: 'Deal Folder' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Data Room' })).not.toBeInTheDocument();
  });

  it('restores the Data Room row when the flag is on', () => {
    openDeal();
    flagOverrides.current = { deal_data_room_nav: true };
    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="storm" />);

    expect(screen.getByRole('link', { name: 'Data Room' })).toHaveAttribute(
      'href',
      '/projects/PALET-2026-497/data-room',
    );
  });

  it('keeps Data Room for external seats with the flag off', () => {
    openDeal();
    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="external" />);

    expect(screen.getByRole('link', { name: 'Data Room' })).toBeInTheDocument();
  });
});
