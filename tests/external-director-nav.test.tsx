import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '@/components/organisms/navigation/Sidebar';
import { COMPANY_ROLE } from '@/lib/constants/roles';

const { useFlagMock, useCurrentUserMock } = vi.hoisted(() => ({
  useFlagMock: vi.fn(),
  useCurrentUserMock: vi.fn(),
}));

vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: useFlagMock }));
vi.mock('@/lib/auth/useCurrentUser', () => ({
  initialsFor: () => 'PD',
  initialsFromEmail: () => 'PD',
  useCurrentUser: useCurrentUserMock,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/companies/co-playboot/members',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/useProfilePhoto', () => ({
  useProfilePhoto: () => ({ photoUrl: null }),
}));
vi.mock('@/lib/deals/useDeals', () => ({
  useDeals: () => ({ deals: [] }),
  useDealListSource: () => ({ apiEnabled: false, fixtureFallback: true }),
  resolveActiveDeal: () => null,
}));
vi.mock('@/lib/rail/gate0', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rail/gate0')>()),
  GATE0_MODAL_ENTRY_ENABLED: true,
}));
vi.mock('@/components/deals/DealSelect', () => ({
  SidebarDealSelect: () => null,
  DealSelectMenuFooter: () => null,
}));
vi.mock('@/components/wizard/NewMandateDialog', () => ({ NewMandateDialog: () => null }));

beforeEach(() => {
  useFlagMock.mockReturnValue(true);
  useCurrentUserMock.mockReturnValue({
    state: {
      status: 'ready',
      data: {
        user: {
          id: 'u-director',
          email: 'admin@playboot.com',
          full_name: 'Playboot Admin',
          display_name: 'Playboot Admin',
          firm_role: null,
          department: null,
          is_external: true,
          status: 'active',
          company_id: 'co-playboot',
          company_role: COMPANY_ROLE.DIRECTOR,
          can_invite: true,
        },
        mandate: null,
      },
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('external company director navigation', () => {
  it('shows conductor center and leads, with their people under Settings', () => {
    render(<Sidebar collapsed={false} onToggle={() => undefined} perspective="external" />);

    expect(screen.getByRole('link', { name: 'Conductor Center' })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: 'Leads' })).toHaveAttribute('href', '/leads');
    // Organization moved into Settings: no nav row, the footer opens Settings.
    expect(screen.queryByRole('link', { name: 'Employees' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('button', { name: 'New deal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Companies' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Setup' })).not.toBeInTheDocument();
  });
});
