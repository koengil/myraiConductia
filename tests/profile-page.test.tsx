import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ProfilePage from '@/app/(authed)/profile/page';
import { PREVIEW_KEEP_LABEL, ProfileView } from '@/app/(authed)/profile/ProfileView';
import { PROFILE_TITLE_PREVIEW_KEY } from '@/app/(authed)/profile/profileTitlePreview';
import { ROLE_LOAD_ERROR, ROLE_SET_BY_DIRECTOR } from '@/app/(authed)/profile/ProfileRoleField';
import { roleLabelFor } from '@/lib/auth/useCurrentUser';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { profileRedirectTarget } from '@/lib/settings/href';
import { PROFILE_FULL_NAME_MAX_LENGTH } from '@/lib/validation/inputPolicy';

const nav = vi.hoisted(() => ({ redirect: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
  redirect: nav.redirect,
}));

const useCurrentUserMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/useCurrentUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/useCurrentUser')>(
    '@/lib/auth/useCurrentUser',
  );
  return { ...actual, useCurrentUser: useCurrentUserMock };
});

const signOut = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({ auth: { signOut } }),
}));

const photo = vi.hoisted(() => ({ savePhoto: vi.fn() }));
vi.mock('@/lib/auth/useProfilePhoto', () => ({
  useProfilePhoto: () => ({ photoUrl: null, savePhoto: photo.savePhoto }),
}));

type UserOverrides = Partial<{
  id: string;
  full_name: string;
  display_name: string | null;
  firm_role: string | null;
  department: string | null;
  is_external: boolean;
  company_id: string | null;
  company_role: string | null;
}>;

function signedIn(overrides: UserOverrides = {}, reload = vi.fn()) {
  useCurrentUserMock.mockReturnValue({
    reload,
    state: {
      status: 'ready',
      data: {
        user: {
          id: 'u-rob',
          email: 'roberto@conductia.com',
          full_name: 'Roberto Di Lillo',
          display_name: null,
          firm_role: null,
          department: 'ib',
          is_external: false,
          status: 'active',
          company_id: null,
          company_role: null,
          can_invite: false,
          ...overrides,
        },
        company: null,
        mandate: null,
      },
    },
  });
  return reload;
}

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

function withFlags(node: React.ReactNode, flags: Record<string, boolean> = {}) {
  return (
    <FlagsProvider value={flags as unknown as React.ComponentProps<typeof FlagsProvider>['value']}>
      {node}
    </FlagsProvider>
  );
}

function row(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-profile-field="${id}"]`);
  if (!el) throw new Error(`no ${id} row`);
  return el;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('/profile', () => {
  it('redirects to Settings › Profile and keeps the connect result query', async () => {
    await ProfilePage({ searchParams: Promise.resolve({ connected: '1' }) });
    expect(nav.redirect).toHaveBeenCalledWith('/settings?section=profile&connected=1');
  });

  it('builds the target from any query, never letting it pick another section', () => {
    expect(profileRedirectTarget({})).toBe('/settings?section=profile');
    expect(profileRedirectTarget({ error: 'work_identity_mismatch', section: 'mail' })).toBe(
      '/settings?section=profile&error=work_identity_mismatch',
    );
    expect(profileRedirectTarget({ a: ['1', '2'] })).toBe('/settings?section=profile&a=1&a=2');
  });
});

describe('Settings › Profile', () => {
  it('does not invent a demo identity when the session profile cannot load', () => {
    useCurrentUserMock.mockReturnValue({ state: { status: 'error' } });
    render(<ProfileView />);
    expect(screen.getByText('Profile is unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByText(/Storm Duncan/i)).not.toBeInTheDocument();
  });

  it('shows only photo, full name, nickname, title, role and email, the email once', () => {
    signedIn();
    vi.stubGlobal('fetch', vi.fn());
    render(<ProfileView />);

    const labels = Array.from(document.querySelectorAll('dt')).map((dt) => dt.textContent);
    expect(labels).toEqual(['Full name', 'Nickname', 'Title', 'Role', 'Email']);
    expect(screen.getByRole('button', { name: 'Change photo' })).toBeInTheDocument();
    expect(screen.getAllByText('roberto@conductia.com')).toHaveLength(1);
    for (const gone of [/Copy email/, /Add photo/, /Remove photo/, /Last synced/, /Deal discovery/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    // The mailbox card moved to Settings › Mail: Profile reads nothing about it.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens the file picker from the avatar', () => {
    signedIn();
    render(<ProfileView />);
    const input = screen.getByLabelText('Choose profile photo') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Change photo' }));
    expect(click).toHaveBeenCalled();
  });

  it('edits the full name with the pencil and saves only that field', async () => {
    const reload = signedIn();
    const fetchMock = vi.fn(() => ok({ user: {} }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ProfileView />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit full name' }));
    const input = screen.getByLabelText('Full name');
    expect(input).toHaveValue('Roberto Di Lillo');
    expect(input).toHaveAttribute('maxlength', String(PROFILE_FULL_NAME_MAX_LENGTH));
    fireEvent.change(input, { target: { value: 'Rob Di Lillo' } });
    fireEvent.click(within(row('full-name')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Full name saved.'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/me',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ fullName: 'Rob Di Lillo' }) }),
    );
    expect(reload).toHaveBeenCalled();
    // Back to text, focus on the pencil.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit full name' })).toHaveFocus());
  });

  it('shows no nickname, never the full name again, when the nickname only repeats it', async () => {
    signedIn({ display_name: 'Roberto Di Lillo' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ProfileView />);
    expect(within(row('full-name')).getByText('Roberto Di Lillo')).toBeInTheDocument();
    expect(within(row('nickname')).queryByText('Roberto Di Lillo')).toBeNull();
    expect(within(row('nickname')).getByText('Not set')).toBeInTheDocument();
    // Opening and saving the empty field saves nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Edit nickname' }));
    expect(screen.getByLabelText('Nickname')).toHaveValue('');
    fireEvent.submit(screen.getByLabelText('Nickname').closest('form')!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a nickname that differs from the full name', () => {
    signedIn({ display_name: 'Rob' });
    vi.stubGlobal('fetch', vi.fn());
    render(<ProfileView />);
    expect(within(row('nickname')).getByText('Rob')).toBeInTheDocument();
  });

  it('clears the nickname with null and cancels with Escape', async () => {
    signedIn({ display_name: 'Rob' });
    const fetchMock = vi.fn(() => ok({ user: {} }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ProfileView />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit nickname' }));
    fireEvent.keyDown(screen.getByLabelText('Nickname'), { key: 'Escape' });
    expect(screen.queryByLabelText('Nickname')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Edit nickname' }));
    fireEvent.change(screen.getByLabelText('Nickname'), { target: { value: '  ' } });
    fireEvent.submit(screen.getByLabelText('Nickname').closest('form')!);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/me',
        expect.objectContaining({ body: JSON.stringify({ displayName: null }) }),
      ),
    );
  });

  it('refuses a full name past the limit without calling the API', async () => {
    signedIn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ProfileView />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit full name' }));
    fireEvent.change(screen.getByLabelText('Full name'), {
      target: { value: 'Z'.repeat(PROFILE_FULL_NAME_MAX_LENGTH + 1) },
    });
    fireEvent.click(within(row('full-name')).getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/characters at most/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the title in this browser as a Preview, never sent to the API', async () => {
    signedIn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<ProfileView />);

    expect(within(row('title')).getByText('Preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
    // Editing still says Preview, and the button never says Save.
    expect(within(row('title')).getByText('Preview')).toBeInTheDocument();
    expect(within(row('title')).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Managing Director' } });
    fireEvent.click(within(row('title')).getByRole('button', { name: PREVIEW_KEEP_LABEL }));

    await waitFor(() => expect(within(row('title')).getByText('Managing Director')).toBeInTheDocument());
    expect(within(row('title')).getByText('Preview')).toBeInTheDocument();
    expect(window.localStorage.getItem(`${PROFILE_TITLE_PREVIEW_KEY}.u-rob`)).toBe('Managing Director');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('offers sign out (the phone path; desktop has the avatar menu and sidebar)', async () => {
    signedIn();
    render(<ProfileView />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(nav.replace).toHaveBeenCalledWith('/sign-in');
  });
});

describe('Settings › Profile › Role and Default deal role', () => {
  const roster = (role: string | null) =>
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PATCH') return ok({ member: {} });
      if (url === '/api/v1/companies/c-bank/members') {
        return ok({ members: [{ id: 'u-rob', preferred_deal_role: role }] });
      }
      return ok({});
    });

  it('is a dropdown of deal roles for a director, saved through the member PATCH', async () => {
    signedIn({ company_id: 'c-bank', company_role: 'director' });
    const fetchMock = roster(null);
    vi.stubGlobal('fetch', fetchMock);
    render(withFlags(<ProfileView />, { platform_onboarding: true }));

    const select = (await screen.findByLabelText('Default deal role')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Not set',
      'Deal Team',
      'Legal Counsel',
      'Observer',
    ]);
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'legal' } });

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Default deal role saved.'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/companies/c-bank/members/u-rob',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ preferredDealRole: 'legal' }) }),
    );
    expect(select.value).toBe('legal');
  });

  it('puts the role back and says so when the save fails', async () => {
    signedIn({ company_id: 'c-bank', company_role: 'director' });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) } as Response)
          : ok({ members: [{ id: 'u-rob', preferred_deal_role: 'deal_team' }] }),
      ),
    );
    render(withFlags(<ProfileView />, { platform_onboarding: true }));
    const select = (await screen.findByLabelText('Default deal role')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('deal_team'));
    fireEvent.change(select, { target: { value: 'read_only' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone changed your default deal role just now.');
    expect(select.value).toBe('deal_team');
  });

  it('names the default deal role when the save fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'PATCH'
          ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)
          : ok({ members: [{ id: 'u-rob', preferred_deal_role: 'deal_team' }] }),
      ),
    );
    render(withFlags(<ProfileView />, { platform_onboarding: true }));
    const select = (await screen.findByLabelText('Default deal role')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('deal_team'));
    fireEvent.change(select, { target: { value: 'read_only' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('The default deal role could not be saved. Try again.');
  });

  it('reads the role for a member, whom a director sets it for', async () => {
    signedIn({ company_id: 'c-bank', company_role: 'member' });
    vi.stubGlobal('fetch', roster('deal_team'));
    render(withFlags(<ProfileView />, { platform_onboarding: true }));
    const dealRole = row('default-deal-role');
    expect(await within(dealRole).findByText('Deal Team')).toBeInTheDocument();
    expect(within(dealRole).getByText(new RegExp(ROLE_SET_BY_DIRECTOR))).toBeInTheDocument();
    expect(within(dealRole).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('says plainly when the deal role cannot load, with no stand-in role', async () => {
    signedIn({ company_id: 'c-bank', company_role: 'director' });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)));
    render(withFlags(<ProfileView />, { platform_onboarding: true }));
    expect(await within(row('default-deal-role')).findByRole('alert')).toHaveTextContent(ROLE_LOAD_ERROR);
    expect(within(row('default-deal-role')).queryByText('Director')).not.toBeInTheDocument();
  });

  it('shows Role as the organization role, read-only, the same label as the avatar Popover', async () => {
    signedIn({ company_id: 'c-bank', company_role: 'director' });
    vi.stubGlobal('fetch', roster(null));
    render(withFlags(<ProfileView />, { platform_onboarding: true }));
    await within(row('default-deal-role')).findByLabelText('Default deal role');

    // The Popover's label comes from roleLabelFor on the same /me profile.
    const popoverLabel = roleLabelFor(useCurrentUserMock().state.data.user);
    expect(popoverLabel).toBe('Director');
    const role = row('role');
    expect(within(role).getByText(popoverLabel)).toBeInTheDocument();
    expect(within(role).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(role).queryByText('Not set')).not.toBeInTheDocument();
  });

  it('shows the organization role when the preference does not apply', () => {
    signedIn({ company_id: 'c-bank', company_role: 'director' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(withFlags(<ProfileView />, { platform_onboarding: false }));
    expect(within(row('role')).getByText('Director')).toBeInTheDocument();
    expect(document.querySelector('[data-profile-field="default-deal-role"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
