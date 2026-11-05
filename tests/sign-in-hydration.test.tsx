import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/components/brand/Wordmark', () => ({ Wordmark: () => null }));

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import SignInPage from '@/app/sign-in/page.client';

const signInWithPassword = vi.fn().mockResolvedValue({ error: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createSupabaseBrowserClient).mockReturnValue({
    auth: { signInWithPassword },
  } as never);
});

const hosts: HTMLElement[] = [];

afterEach(() => {
  while (hosts.length) hosts.pop()?.remove();
});

function mountServerMarkup() {
  const host = document.createElement('div');
  hosts.push(host);
  host.innerHTML = renderToString(<SignInPage />);
  document.body.appendChild(host);
  return host;
}

describe('sign-in before hydration', () => {
  it('cannot submit the form natively while the client handler is absent', () => {
    const host = mountServerMarkup();
    const form = host.querySelector('form') as HTMLFormElement;
    const button = host.querySelector('button[type="submit"]') as HTMLButtonElement;
    const submitted = vi.fn();
    form.addEventListener('submit', submitted);

    fireEvent.click(button);

    expect(button.disabled).toBe(true);
    expect(submitted).not.toHaveBeenCalled();
  });

  it('tells the user the control is not live yet', () => {
    const host = mountServerMarkup();
    const button = host.querySelector('button[type="submit"]') as HTMLButtonElement;

    expect(button.textContent).toBe('Preparing sign in…');
  });

  it('enables the control once mounted', () => {
    render(<SignInPage />);
    const button = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;

    expect(button.disabled).toBe(false);
  });
});
