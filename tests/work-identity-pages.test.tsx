import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

const nav = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
}));
const state = vi.hoisted(() => ({
  flagOn: true,
  status: 'invited' as string | null,
  methods: [] as Array<{ method: string }>,
  mfaRequired: true,
  providers: [] as string[],
  sessionToken: '' as string,
  refreshedToken: '' as string,
  refreshSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace, refresh: nav.refresh }),
  useSearchParams: () => ({ get: () => null }),
  redirect: nav.redirect,
  notFound: nav.notFound,
}));
vi.mock('@/components/brand/Wordmark', () => ({ Wordmark: () => null }));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/app/two-factor/page.client', () => ({
  default: ({ destination }: { destination: string }) => <p>enroll:{destination}</p>,
}));
vi.mock('@/lib/api/v1/requireFlag', () => ({
  isFlagEnabled: vi.fn(async () => state.flagOn),
}));
vi.mock('@/lib/auth/mfaPolicy', async (original) => ({
  ...(await original<typeof import('@/lib/auth/mfaPolicy')>()),
  isMfaRequiredForUser: () => state.mfaRequired,
}));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: 'u1', app_metadata: { providers: state.providers } } },
      }),
      getSession: async () => ({ data: { session: { access_token: state.sessionToken } } }),
      refreshSession: state.refreshSession,
      signOut: state.signOut,
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentAuthenticationMethods: state.methods },
        }),
      },
    },
  })),
  createSupabaseAdminClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { status: state.status }, error: null }) }),
      }),
    }),
  })),
}));

import SignInPage from '@/app/sign-in/page.client';
import JoinPageClient from '@/app/join/page.client';
import JoinPage from '@/app/join/page';
import ConfirmJoinClient from '@/app/join/confirm/page.client';
import TwoFactorPage from '@/app/two-factor/page';

const INVITE = '11111111-1111-4111-8111-111111111111';
const NONCE = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  state.flagOn = true;
  state.status = 'invited';
  state.methods = [];
  state.mfaRequired = true;
  state.providers = [];
  state.sessionToken = '';
  state.refreshedToken = '';
  state.refreshSession.mockImplementation(async () => ({
    data: { session: { access_token: state.refreshedToken } },
    error: null,
  }));
  state.signOut.mockResolvedValue({ error: null });
  window.sessionStorage.clear();
});

function tokenWith(payload: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(payload))}.s`;
}

describe('sign-in work-account buttons', () => {
  it('are absent when the flag is off and the password form is unchanged', () => {
    render(<SignInPage />);
    expect(screen.queryByRole('button', { name: /Google Workspace|Microsoft/ })).toBeNull();
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('render both providers when the flag is on and show a returned error as an alert', () => {
    render(<SignInPage workIdentityEnabled workIdentityError="Open your invitation email to continue." />);
    expect(screen.getByRole('button', { name: 'Continue with Google Workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with Microsoft' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/invitation/);
    // A provider error does not open the email fields.
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.getByRole('button', { name: 'Or sign in with email' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keep the email and password fields behind "Or sign in with email" until it is clicked', () => {
    render(<SignInPage workIdentityEnabled />);
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Or sign in with email' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Nothing to control while collapsed, so no dangling reference.
    expect(toggle.getAttribute('aria-controls')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-controls')).toBe('email-signin-fields');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const email = screen.getByLabelText('Email');
    expect(email).toBe(document.activeElement);
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(document.getElementById('email-signin-fields')).toBeTruthy();
    // Once open, the fields stay open.
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });

  it('keep the fields open and show the error when an email sign-in fails', async () => {
    const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');
    vi.mocked(createSupabaseBrowserClient).mockReturnValue({
      auth: { signInWithPassword: vi.fn().mockResolvedValue({ error: { message: 'Invalid login credentials' } }) },
    } as never);
    render(<SignInPage workIdentityEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Or sign in with email' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'md@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/ }));
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid login credentials');
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Or sign in with email' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('put Google and Microsoft first, then "Or sign in with email", then the email form', () => {
    render(<SignInPage workIdentityEnabled />);
    const google = screen.getByRole('button', { name: 'Continue with Google Workspace' });
    const microsoft = screen.getByRole('button', { name: 'Continue with Microsoft' });
    const divider = screen.getByText('Or sign in with email');
    fireEvent.click(divider);
    const email = screen.getByLabelText('Email');
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(google, microsoft)).toBe(true);
    expect(follows(microsoft, divider)).toBe(true);
    expect(follows(divider, email)).toBe(true);
  });

  it('show the email form alone, with no divider, when the flag is off', () => {
    render(<SignInPage />);
    expect(screen.queryByText(/^Or /)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });
});

describe('/join', () => {
  it('404s when the flag is off', async () => {
    state.flagOn = false;
    await expect(JoinPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('NOT_FOUND');
  });

  it('offers the firm provider and no password field', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(
      <JoinPageClient invite={INVITE} nonce={NONCE} error={null} step={null} connected={false} provider="azure" />,
    );
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Microsoft' }));
    expect(assign).toHaveBeenCalledWith(`/auth/work/start?invite=${INVITE}&k=${NONCE}`);
    vi.unstubAllGlobals();
  });

  it('restarts the same invitation from session storage after a failed round trip', () => {
    window.sessionStorage.setItem('conductia.join.invitation', JSON.stringify({ invite: INVITE, nonce: NONCE }));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(
      <JoinPageClient
        invite={null}
        nonce={null}
        error={{ message: 'Sign in with the account the invitation was sent to.', recovery: 'switch_account' }}
        step={null}
        connected={false}
        provider={null}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/account/);
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }));
    expect(assign).toHaveBeenCalledWith(`/auth/work/start?invite=${INVITE}&k=${NONCE}`);
    vi.unstubAllGlobals();
  });

  it.each([
    ['google', ['Connect Google Workspace']],
    [null, ['Connect Google Workspace', 'Connect Microsoft']],
  ] as const)('the connect step offers only the firm provider %s', (provider, labels) => {
    render(
      <JoinPageClient invite={INVITE} nonce={NONCE} error={null} step="connect" connected={false} provider={provider} />,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(labels);
  });

  it('sends an ambiguous connect back to the connect step, not the invite start', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(
      <JoinPageClient
        invite={INVITE}
        nonce={NONCE}
        error={{ message: 'Pick one.', recovery: 'connect' }}
        step={null}
        connected={false}
        provider={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect again' }));
    expect(assign).toHaveBeenCalledWith(`/join?invite=${INVITE}&k=${NONCE}&step=connect`);
    vi.unstubAllGlobals();
  });

  it('routes an existing account to sign in, then connect', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(
      <JoinPageClient
        invite={INVITE}
        nonce={NONCE}
        error={{ message: 'Sign in first.', recovery: 'sign_in_then_connect' }}
        step={null}
        connected={false}
        provider={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to your account' }));
    const target = new URL(assign.mock.calls[0][0] as string, 'http://x');
    expect(target.pathname).toBe('/sign-in');
    expect(target.searchParams.get('redirectTo')).toBe(`/join?invite=${INVITE}&k=${NONCE}&step=connect`);
    vi.unstubAllGlobals();
  });

  it('shows the invitation-email instruction without an invitation', () => {
    render(<JoinPageClient invite={null} nonce={null} error={null} step={null} connected={false} provider={null} />);
    expect(screen.getByRole('status').textContent).toMatch(/invitation email/);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('/join/confirm', () => {
  it('requires the terms before accepting and lands on the invited deal', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
      if (url === '/api/v1/work-identity/context') {
        return new Response(
          JSON.stringify({
            email: 'ana@bank.com',
            displayName: 'Ana Banker',
            inviterName: 'Storm Duncan',
            companyName: 'Bank',
            dealCodename: 'Atlas',
            companyRole: 'banker',
            dealRole: 'deal_team',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ dealId: 'd1', dealCode: 'D-7' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ConfirmJoinClient />);
    const name = (await screen.findByLabelText('Display name')) as HTMLInputElement;
    expect(name.value).toBe('Ana Banker');
    const submit = screen.getByRole('button', { name: 'Accept invitation' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/projects/D-7'));
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      displayName: 'Ana Banker',
      tosAccepted: true,
    });
    vi.unstubAllGlobals();
  });

  it('sends an aal1 session back to verification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'mfa_required' }), { status: 403 })),
    );
    render(<ConfirmJoinClient />);
    expect(await screen.findByRole('link', { name: 'Continue verification' })).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('/two-factor for invited users', () => {
  async function renderPage(): Promise<string> {
    try {
      const element = (await TwoFactorPage({
        searchParams: Promise.resolve({ redirectTo: '/projects/D-1' }),
      })) as ReactElement;
      render(element);
      return screen.getByText(/^enroll:/).textContent ?? '';
    } catch (error) {
      return (error as Error).message;
    }
  }

  it('enrolls a work-identity invitee with /join/confirm as the only destination', async () => {
    state.methods = [{ method: 'oauth' }];
    expect(await renderPage()).toBe('enroll:/join/confirm');
  });

  it('keeps legacy invitees on /accept-invite', async () => {
    state.methods = [{ method: 'password' }];
    expect(await renderPage()).toBe('REDIRECT:/accept-invite');
  });

  it('keeps an OAuth invitee on /accept-invite when the flag is off', async () => {
    state.methods = [{ method: 'oauth' }];
    state.flagOn = false;
    expect(await renderPage()).toBe('REDIRECT:/accept-invite');
  });

  it('sends an activated banker on to MFA with their destination', async () => {
    state.status = 'active';
    expect(await renderPage()).toBe('enroll:/projects/D-1');
  });
});

describe('/two-factor work-identity hook check', () => {
  async function renderPage(): Promise<string> {
    try {
      const element = (await TwoFactorPage({
        searchParams: Promise.resolve({ redirectTo: '/projects/D-1' }),
      })) as ReactElement;
      render(element);
      return screen.getByText(/^enroll:/).textContent ?? '';
    } catch (error) {
      return (error as Error).message;
    }
  }

  beforeEach(() => {
    state.status = 'active';
    state.providers = ['azure'];
  });

  // The page is a Server Component, where cookie writes are discarded (audit
  // item 2): it only reads. The refresh and the local sign-out happen in the
  // middleware, which now matches /two-factor (tests/middleware-mfa.test.ts).
  it('refuses a work-identity session without the claim, and writes nothing: no refresh, no sign-out', async () => {
    state.sessionToken = tokenWith({ sub: 'u1' });
    state.refreshedToken = tokenWith({ sub: 'u1', work_identity_hook: 1 });
    expect(await renderPage()).toBe('REDIRECT:/sign-in?error=work_identity_not_connected');
    expect(state.refreshSession).not.toHaveBeenCalled();
    expect(state.signOut).not.toHaveBeenCalled();
    expect(screen.queryByText(/^enroll:/)).toBeNull();
  });

  it('does not refresh a work-identity session that carries the claim', async () => {
    state.sessionToken = tokenWith({ sub: 'u1', work_identity_hook: 1 });
    expect(await renderPage()).toBe('enroll:/projects/D-1');
    expect(state.refreshSession).not.toHaveBeenCalled();
  });

  it('leaves a password user untouched', async () => {
    state.providers = ['email'];
    expect(await renderPage()).toBe('enroll:/projects/D-1');
    expect(state.refreshSession).not.toHaveBeenCalled();
    expect(state.signOut).not.toHaveBeenCalled();
  });
});
