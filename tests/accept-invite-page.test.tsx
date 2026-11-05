/**
 * Accept page context rendering (spec-v3 criterion 3, cr-prr-124 1.1):
 * inviter + company + optional deal codename appear before the form, and a
 * closed invite (revoked/expired) dead-ends before any password is typed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/components/brand/Wordmark', () => ({ Wordmark: () => null }));

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import AcceptInvitePage from '@/app/accept-invite/page.client';

const updateUserMock = vi.fn(async () => ({ error: null }));

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
      updateUser: updateUserMock,
    },
  } as never);
}

function stubContext(payload: Record<string, unknown>, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => payload })),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('accept-invite page context', () => {
  it('withholds context until the recipient verifies the out-of-band code', async () => {
    signedInInvitee();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/verify')) {
        return {
          ok: true,
          json: async () => ({ verified: true, attemptsRemaining: 5, locked: false }),
        };
      }
      if (fetchMock.mock.calls.filter(([called]) => String(called).endsWith('/context')).length === 1) {
        return {
          ok: true,
          json: async () => ({
            status: 'pending',
            email: 'director@vista.com',
            verificationRequired: true,
            locked: false,
          }),
        };
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
          dealCodename: 'Project Rangers',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AcceptInvitePage />);

    const code = await screen.findByLabelText('Verification code');
    expect(screen.queryByText(/Storm Duncan/)).not.toBeInTheDocument();
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.submit(code.closest('form') as HTMLFormElement);
    await screen.findByText(
      'Storm Duncan invited you to join Vista Equity Partners on Project Rangers.',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/invites/verify',
      expect.objectContaining({ body: JSON.stringify({ code: '123456' }) }),
    );
  });

  it('renders inviter, company, and deal codename for a deal invitation', async () => {
    signedInInvitee();
    stubContext({
      status: 'pending',
      inviterName: 'Storm Duncan',
      companyName: 'Vista Equity Partners',
      dealCodename: 'Project Rangers',
    });
    render(<AcceptInvitePage />);
    await waitFor(() =>
      expect(
        screen.getByText('Storm Duncan invited you to join Vista Equity Partners on Project Rangers.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('renders inviter and company without a deal for a company-only invitation', async () => {
    signedInInvitee();
    stubContext({
      status: 'pending',
      inviterName: 'Storm Duncan',
      companyName: 'Conductia',
      dealCodename: null,
    });
    render(<AcceptInvitePage />);
    await waitFor(() =>
      expect(screen.getByText('Storm Duncan invited you to join Conductia.')).toBeInTheDocument(),
    );
  });

  it('sends accepted invitees through platform 2FA before the protected destination', async () => {
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
          dealCodename: 'Project Rangers',
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
    fireEvent.submit(screen.getByLabelText('Password').closest('form') as HTMLFormElement);

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        '/two-factor?redirectTo=%2Fprojects%2Frangers',
      ),
    );
    // The password rides in the acceptance request; the page never writes it
    // to the account on its own (plan 1a credential transition).
    expect(updateUserMock).not.toHaveBeenCalled();
    const acceptCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/accept'));
    expect(JSON.parse(String(((acceptCall as unknown[] | undefined)?.[1] as RequestInit | undefined)?.body))).toMatchObject({
      displayName: 'Alex Director',
      password: 'correct horse battery staple',
    });
  });

  it('asks for a resend when the account lost its invite keys', async () => {
    signedInInvitee();
    stubContext({ code: 'invite_context_missing', error: 'x' }, false);
    render(<AcceptInvitePage />);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'This invitation needs to be resent. Ask the sender to resend it.',
      ),
    );
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  });

  it('asks for a resend when acceptance reports invite_context_missing', async () => {
    signedInInvitee();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/accept')) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ code: 'invite_context_missing', error: 'x' }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            status: 'pending',
            email: 'director@vista.com',
            verificationRequired: false,
            locked: false,
            inviterName: 'Storm Duncan',
            companyName: 'Vista',
            dealCodename: null,
          }),
        };
      }),
    );
    render(<AcceptInvitePage />);
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'secret-pass' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'secret-pass' } });
    fireEvent.submit(screen.getByLabelText('Password').closest('form') as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/needs to be resent/),
    );
  });

  it('dead-ends a revoked invitation before the form', async () => {
    signedInInvitee();
    stubContext({ status: 'revoked', inviterName: 'x', companyName: 'y', dealCodename: null });
    render(<AcceptInvitePage />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/revoked/));
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  });

  it('dead-ends an expired invitation with resend guidance', async () => {
    signedInInvitee();
    stubContext({ status: 'expired', inviterName: 'x', companyName: 'y', dealCodename: null });
    render(<AcceptInvitePage />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/expired/));
    expect(screen.getByRole('status')).toHaveTextContent(/resend/);
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  });

  it('dead-ends when trusted context cannot be established (cr-prr-124-r2 1.1)', async () => {
    // The context endpoint binds the invite to the authenticated identity, so
    // a failed read means the invitation is unverifiable — no acceptance form.
    signedInInvitee();
    stubContext({}, false);
    render(<AcceptInvitePage />);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/could not be verified/),
    );
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  });
});

it('dead-ends and keeps the hash when the session exchange fails', async () => {
  // The hash tokens are the only retry state — a failed setSession must not
  // strip them, and must not fall through to polling (review 6bdabd9 finding 2).
  window.location.hash = '#access_token=tok-a&refresh_token=tok-r&type=invite';
  vi.mocked(createSupabaseBrowserClient).mockReturnValue({
    auth: {
      setSession: async () => ({ error: { message: 'invalid token' } }),
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  } as never);
  render(<AcceptInvitePage />);
  const status = await screen.findByRole('status');
  expect(status).toHaveTextContent(/could not sign you in/i);
  expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  expect(window.location.hash).toContain('access_token');
  window.location.hash = '';
});
