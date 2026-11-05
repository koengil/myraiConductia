import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

const nav = vi.hoisted(() => ({
  search: '',
  redirect: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
}));
const user = vi.hoisted(() => ({ state: { status: 'loading', email: null } as unknown }));
const navUser = vi.hoisted(() => ({ current: null as null | { company_id: string | null } }));

vi.mock('next/navigation', () => ({
  redirect: nav.redirect,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: () => ({ state: user.state }) }));
vi.mock('@/lib/navigation/serverNav', () => ({ getNavUser: async () => navUser.current }));
vi.mock('@/components/company/CompanyMembersWorkspace', () => ({
  CompanyMembersView: ({ companyId, inSettings }: { companyId: string; inSettings?: boolean }) => (
    <p>{`roster ${companyId} ${inSettings ? 'in settings' : 'standalone'}`}</p>
  ),
}));
vi.mock('@/components/company/CompanyRolesWorkspace', () => ({
  CompanyRolesWorkspace: ({ companyId, inSettings }: { companyId: string; inSettings?: boolean }) => (
    <p>{`roles ${companyId} ${inSettings ? 'in settings' : 'standalone'}`}</p>
  ),
}));
vi.mock('@/lib/access/useRequestAccess', () => ({
  useRequestAccess: () => ({ pending: false, busy: false, error: null, requestAccess: vi.fn() }),
}));

import { OrganizationSettings } from '@/components/company/OrganizationSettings';
import { CompanyTabs } from '@/components/company/CompanyTabs';
import { RailsSettings } from '@/components/settings/RailsSettings';
import OrganizationPage from '@/app/(authed)/organization/page';
import CompanyMembersPage from '@/app/(authed)/companies/[companyId]/members/page';
import CompanyRolesPage from '@/app/(authed)/companies/[companyId]/roles/page';
import { ProfileView } from '@/app/(authed)/profile/ProfileView';
import { SETTINGS_SECTIONS } from '@/lib/settings/sections';
import { organizationSettingsHref } from '@/lib/settings/href';
import { getLocalPref } from '@/lib/prefs/localPrefs';

function ready(companyId: string | null) {
  return { status: 'ready', data: { user: { company_id: companyId } } };
}

beforeEach(() => {
  nav.search = '';
  navUser.current = null;
  user.state = { status: 'loading', email: null };
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings › Organization', () => {
  it('shows the viewer’s own company roster inside Settings', () => {
    user.state = ready('c1');
    render(<OrganizationSettings />);
    expect(screen.getByText('roster c1 in settings')).toBeInTheDocument();
  });

  it('opens the Roles tab from ?tab=roles', () => {
    user.state = ready('c1');
    nav.search = 'section=organization&tab=roles';
    render(<OrganizationSettings />);
    expect(screen.getByText('roles c1 in settings')).toBeInTheDocument();
  });

  it('asks for access when the viewer has no company yet', () => {
    user.state = ready(null);
    render(<OrganizationSettings />);
    expect(screen.getByRole('region', { name: 'Access needed for Organization' })).toBeInTheDocument();
  });

  it('says plainly when the profile could not load', () => {
    user.state = { status: 'error', email: null };
    render(<OrganizationSettings />);
    expect(screen.getByRole('alert')).toHaveTextContent('Your organization could not be loaded.');
  });

  it('keeps the company tabs inside Settings', () => {
    render(<CompanyTabs companyId="c1" current="roster" inSettings />);
    expect(screen.getByRole('link', { name: 'Roster' })).toHaveAttribute('href', '/settings?section=organization');
    expect(screen.getByRole('link', { name: 'Permission requests' })).toHaveAttribute(
      'href',
      '/settings?section=organization&tab=requests',
    );
    expect(screen.getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'href',
      '/settings?section=organization&tab=roles',
    );
  });

  it('leaves the standalone company tabs on the company URLs', () => {
    render(<CompanyTabs companyId="c9" current="roster" />);
    expect(screen.getByRole('link', { name: 'Roster' })).toHaveAttribute('href', '/companies/c9/members');
    expect(screen.getByRole('link', { name: 'Roles' })).toHaveAttribute('href', '/companies/c9/roles');
  });
});

describe('old organization URLs', () => {
  it('/organization redirects into Settings › Organization', () => {
    expect(() => OrganizationPage()).toThrow('REDIRECT:/settings?section=organization');
  });

  it('redirects your own company roster, keeping the requests tab', async () => {
    navUser.current = { company_id: 'c1' };
    await expect(
      CompanyMembersPage({ params: Promise.resolve({ companyId: 'c1' }), searchParams: Promise.resolve({}) }),
    ).rejects.toThrow(`REDIRECT:${organizationSettingsHref()}`);
    await expect(
      CompanyMembersPage({
        params: Promise.resolve({ companyId: 'c1' }),
        searchParams: Promise.resolve({ tab: 'requests' }),
      }),
    ).rejects.toThrow(`REDIRECT:${organizationSettingsHref('requests')}`);
  });

  it('redirects your own company roles to the Roles tab', async () => {
    navUser.current = { company_id: 'c1' };
    await expect(CompanyRolesPage({ params: Promise.resolve({ companyId: 'c1' }) })).rejects.toThrow(
      'REDIRECT:/settings?section=organization&tab=roles',
    );
  });

  it('still renders another company’s roster and roles in place', async () => {
    navUser.current = { company_id: 'c1' };
    render(
      (await CompanyMembersPage({
        params: Promise.resolve({ companyId: 'c9' }),
        searchParams: Promise.resolve({}),
      })) as ReactElement,
    );
    expect(screen.getByText('roster c9 standalone')).toBeInTheDocument();
    cleanup();
    render((await CompanyRolesPage({ params: Promise.resolve({ companyId: 'c9' }) })) as ReactElement);
    expect(screen.getByText('roles c9 standalone')).toBeInTheDocument();
    expect(nav.redirect).not.toHaveBeenCalled();
  });
});

describe('Settings › Profile and Rails', () => {
  it('Profile renders the profile inside Settings', () => {
    const profile = SETTINGS_SECTIONS.find((s) => s.id === 'profile')!;
    const element = profile.render() as ReactElement;
    expect(element.type).toBe(ProfileView);
  });

  it('Rails holds the ask-before-changing switch, stored in this browser', async () => {
    render(<RailsSettings />);
    const toggle = await screen.findByRole('checkbox', { name: 'Ask before changing the rail' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toBeChecked();
    expect(screen.getByText(/kept in this browser only/)).toBeInTheDocument();

    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle).not.toBeChecked();
    expect(getLocalPref('railEditPrompt')).toBe('never');

    act(() => {
      fireEvent.click(toggle);
    });
    expect(getLocalPref('railEditPrompt')).toBe('ask');
  });

  it('Rails starts unchecked when "Don’t ask again" was chosen on the rail', async () => {
    window.localStorage.setItem('conductia.pref.railEditPrompt', 'never');
    render(<RailsSettings />);
    const toggle = await screen.findByRole('checkbox', { name: 'Ask before changing the rail' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
  });
});
