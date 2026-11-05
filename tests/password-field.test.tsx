/**
 * Password entry affordances (#131): the invite acceptance screen is a
 * one-shot credential set on an invite-only account, so a mistyped password
 * must be caught before submit rather than locking the invitee out.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/components/brand/Wordmark', () => ({ Wordmark: () => null }));

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import AcceptInvitePage from '@/app/accept-invite/page.client';
import SignInPage from '@/app/sign-in/page.client';

const updateUser = vi.fn(async () => ({ error: null }));

function signedInInvitee() {
  vi.mocked(createSupabaseBrowserClient).mockReturnValue({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            email: 'director@vista.com',
            user_metadata: { invite_id: 'inv-1', credential_nonce: 'n1' },
          },
        },
      }),
      updateUser,
    },
  } as never);
}

function stubPendingInvite() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'pending',
        email: 'director@vista.com',
        verificationRequired: false,
        locked: false,
        inviterName: 'Storm Duncan',
        companyName: 'Vista Equity Partners',
        dealCodename: null,
      }),
    })),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('accept-invite password confirmation', () => {
  it('blocks submit and names the mismatch when the two passwords differ', async () => {
    signedInInvitee();
    stubPendingInvite();
    render(<AcceptInvitePage />);

    fireEvent.change(await screen.findByLabelText('Your name'), {
      target: { value: 'Alex Director' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correct horse battery stapel' },
    });

    expect(await screen.findByText('Both passwords must match.')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Accept invitation' })).toBeDisabled();

    fireEvent.submit(screen.getByLabelText('Password').closest('form') as HTMLFormElement);

    await waitFor(() => expect(updateUser).not.toHaveBeenCalled());
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('accepts the invitation once the confirmation matches', async () => {
    signedInInvitee();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/accept')) {
        return { ok: true, json: async () => ({ dealCode: 'rangers' }) };
      }
      return {
        ok: true,
        json: async () => ({
          status: 'pending',
          email: 'director@vista.com',
          verificationRequired: false,
          locked: false,
          inviterName: 'Storm Duncan',
          companyName: 'Vista Equity Partners',
          dealCodename: null,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AcceptInvitePage />);

    fireEvent.change(await screen.findByLabelText('Your name'), {
      target: { value: 'Alex Director' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correct horse battery staple' },
    });

    expect(screen.queryByText('Both passwords must match.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.submit(screen.getByLabelText('Password').closest('form') as HTMLFormElement);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    const acceptCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/accept'));
    expect(JSON.parse(String(((acceptCall as unknown[] | undefined)?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      password: 'correct horse battery staple',
    });
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('password visibility toggle', () => {
  it('flips both invite fields between hidden and revealed independently', async () => {
    signedInInvitee();
    stubPendingInvite();
    render(<AcceptInvitePage />);

    const password = await screen.findByLabelText('Password');
    const confirm = screen.getByLabelText('Confirm password');
    expect(password).toHaveAttribute('type', 'password');
    expect(confirm).toHaveAttribute('type', 'password');

    const reveal = screen.getByRole('button', { name: 'Show password' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(reveal);

    expect(password).toHaveAttribute('type', 'text');
    expect(confirm).toHaveAttribute('type', 'password');
    const hide = screen.getByRole('button', { name: 'Hide password' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(hide);
    expect(password).toHaveAttribute('type', 'password');
  });

  it('reveals the sign-in password without offering a confirmation field', () => {
    vi.mocked(createSupabaseBrowserClient).mockReturnValue({
      auth: { signInWithPassword: async () => ({ error: null }) },
    } as never);
    render(<SignInPage />);

    const password = screen.getByLabelText('Password');
    expect(password).toHaveAttribute('type', 'password');
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
  });
});
