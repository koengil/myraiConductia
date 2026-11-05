import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';

/*
 * auth-js resolves signOut() with { error } rather than throwing. A
 * refused sign-out keeps the person where they are, clears nothing and says
 * so; a successful one behaves as before.
 */

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => ({}),
  usePathname: () => '/projects',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/lib/session/clearLocalStores', () => ({ clearLocalStores: vi.fn() }));

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { clearLocalStores } from '@/lib/session/clearLocalStores';
import { useSignOut } from '@/lib/auth/useSignOut';
import { ProfileMenu } from '@/components/profile/ProfileMenu';

const signOut = vi.fn();

beforeEach(() => {
  vi.mocked(createSupabaseBrowserClient).mockReturnValue({
    auth: {
      getUser: async () => ({ data: { user: { email: 'md@bank.test' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut,
    },
  } as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const REFUSED = { error: { message: 'Network request failed', name: 'AuthRetryableFetchError' } };

describe('useSignOut', () => {
  it('stays put, clears nothing and says so when signOut resolves with an error', async () => {
    signOut.mockResolvedValue(REFUSED);
    const { result } = renderHook(() => useSignOut());
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.error).toBe('Could not sign out. Try again.');
    expect(result.current.signingOut).toBe(false);
    expect(clearLocalStores).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('clears and routes to /sign-in on success', async () => {
    signOut.mockResolvedValue({ error: null });
    const { result } = renderHook(() => useSignOut());
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.error).toBeNull();
    expect(clearLocalStores).toHaveBeenCalledOnce();
    expect(router.replace).toHaveBeenCalledWith('/sign-in');
  });
});

describe('ProfileMenu sign out', () => {
  it('stays put, clears nothing and says so when signOut resolves with an error', async () => {
    signOut.mockResolvedValue(REFUSED);
    render(<ProfileMenu name="Storm Duncan" roleLabel="Managing Director" initials="SD" />);
    fireEvent.click(screen.getByRole('button', { name: /open profile menu/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Could not sign out. Try again.')).toBeInTheDocument();
    expect(clearLocalStores).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });

  it('clears and routes to /sign-in on success', async () => {
    signOut.mockResolvedValue({ error: null });
    render(<ProfileMenu name="Storm Duncan" roleLabel="Managing Director" initials="SD" />);
    fireEvent.click(screen.getByRole('button', { name: /open profile menu/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/sign-in'));
    expect(clearLocalStores).toHaveBeenCalledOnce();
  });
});

