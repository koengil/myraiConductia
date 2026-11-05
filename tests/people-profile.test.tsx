import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

/*
 * Profile, kept in this browser: the photo is per person, a photo the
 * browser cannot keep says so and keeps the old one, and the Preview
 * title has a Reset.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings',
}));

const userId = vi.hoisted(() => ({ current: 'u-rob' }));
vi.mock('@/lib/auth/useCurrentUser', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/useCurrentUser')>('@/lib/auth/useCurrentUser');
  return {
    ...actual,
    useCurrentUser: () => ({
      reload: vi.fn(),
      state: {
        status: 'ready',
        data: {
          user: {
            id: userId.current,
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
          },
          company: null,
          mandate: null,
        },
      },
    }),
  };
});
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({ auth: { signOut: async () => ({ error: null }) } }),
}));

import { PROFILE_PHOTO_STORAGE_KEY, useProfilePhoto } from '@/lib/auth/useProfilePhoto';
import { PREVIEW_KEEP_LABEL, ProfileView } from '@/app/(authed)/profile/ProfileView';
import { PROFILE_TITLE_PREVIEW_KEY } from '@/app/(authed)/profile/profileTitlePreview';

const OLD = 'data:image/png;base64,T0xE';

function row(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-profile-field="${id}"]`)!;
}

function avatarImage(): string | null {
  const button = screen.getByRole('button', { name: 'Change photo' });
  const span = button.querySelector<HTMLElement>('span[style]');
  return span?.style.backgroundImage || null;
}

beforeEach(() => {
  window.localStorage.clear();
  userId.current = 'u-rob';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useProfilePhoto is per person', () => {
  it("never shows one person's photo to the next person in this browser", () => {
    const a = renderHook(() => useProfilePhoto('user-a'));
    act(() => {
      expect(a.result.current.savePhoto(OLD)).toBe(true);
    });
    expect(a.result.current.photoUrl).toBe(OLD);
    a.unmount();

    const b = renderHook(() => useProfilePhoto('user-b'));
    expect(b.result.current.photoUrl).toBeNull();
  });

  it('ignores the old single-key photo', () => {
    window.localStorage.setItem(PROFILE_PHOTO_STORAGE_KEY, OLD);
    const { result } = renderHook(() => useProfilePhoto('user-b'));
    expect(result.current.photoUrl).toBeNull();
  });

  it('reads storage once per person, not on every render', () => {
    window.localStorage.setItem(`${PROFILE_PHOTO_STORAGE_KEY}.user-a`, OLD);
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const { result, rerender } = renderHook(() => useProfilePhoto('user-a'));
    rerender();
    rerender();
    expect(result.current.photoUrl).toBe(OLD);
    expect(getItem.mock.calls.filter(([key]) => key === `${PROFILE_PHOTO_STORAGE_KEY}.user-a`)).toHaveLength(1);
  });

  it('has no photo before the person is known', () => {
    const { result } = renderHook(() => useProfilePhoto(null));
    expect(result.current.photoUrl).toBeNull();
  });

  it('renders initials, not the other person\'s photo, on the profile', () => {
    renderHook(() => useProfilePhoto('user-a')).result.current.savePhoto(OLD);
    userId.current = 'user-b';
    render(<ProfileView />);
    expect(avatarImage()).toBeNull();
    expect(screen.getByRole('button', { name: 'Change photo' }).textContent).toMatch(/^[A-Z]{1,2}/);
  });
});

describe('a photo the browser cannot keep', () => {
  it('says so and keeps the previous photo', async () => {
    window.localStorage.setItem(`${PROFILE_PHOTO_STORAGE_KEY}.u-rob`, OLD);
    render(<ProfileView />);
    expect(avatarImage()).toContain(OLD);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const file = new File([new Uint8Array(64)], 'big.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Choose profile photo'), { target: { files: [file] } });

    expect(
      await screen.findByText('This photo could not be kept in this browser. Try a smaller one.'),
    ).toBeInTheDocument();
    expect(avatarImage()).toContain(OLD);
  });
});

describe('the Preview title has a Reset', () => {
  it('offers Reset once a title is kept, and Reset clears it for good', async () => {
    const first = render(<ProfileView />);
    expect(within(row('title')).queryByRole('button', { name: 'Reset' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Managing Director' } });
    fireEvent.click(within(row('title')).getByRole('button', { name: PREVIEW_KEEP_LABEL }));
    await waitFor(() => expect(within(row('title')).getByText('Managing Director')).toBeInTheDocument());

    fireEvent.click(within(row('title')).getByRole('button', { name: 'Reset' }));
    expect(within(row('title')).getByText('Not set')).toBeInTheDocument();
    expect(window.localStorage.getItem(`${PROFILE_TITLE_PREVIEW_KEY}.u-rob`)).toBeNull();

    // After a reload, still gone.
    first.unmount();
    render(<ProfileView />);
    expect(within(row('title')).getByText('Not set')).toBeInTheDocument();
    expect(within(row('title')).queryByRole('button', { name: 'Reset' })).toBeNull();
  });
});
