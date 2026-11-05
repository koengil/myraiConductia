import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  redirectTo: '/projects',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigation.replace, refresh: navigation.refresh }),
  useSearchParams: () => ({
    get: (key: string) => (key === 'redirectTo' ? navigation.redirectTo : null),
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/components/brand/Wordmark', () => ({ Wordmark: () => null }));

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import SignInPage from '@/app/sign-in/page.client';

beforeEach(() => {
  vi.clearAllMocks();
  navigation.redirectTo = '/projects';
  vi.mocked(createSupabaseBrowserClient).mockReturnValue({
    auth: { signInWithPassword: vi.fn().mockResolvedValue({ error: null }) },
  } as never);
});

async function submitSignIn() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'md@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());
}

describe('password sign-in MFA handoff', () => {
  it('preserves a safe internal destination and lets middleware decide MFA', async () => {
    navigation.redirectTo = '/projects/rangers?tab=mail';
    render(<SignInPage />);
    await submitSignIn();
    expect(navigation.replace).toHaveBeenCalledWith('/projects/rangers?tab=mail');
  });

  it('falls back to projects for an external destination', async () => {
    navigation.redirectTo = 'https://evil.example/steal';
    render(<SignInPage />);
    await submitSignIn();
    expect(navigation.replace).toHaveBeenCalledWith('/projects');
  });
});
