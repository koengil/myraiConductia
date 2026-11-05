import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

/*
 * #162: every sign-out call site aborts the shared reads BEFORE it calls
 * signOut(), so a read started as the signed-in user is already cut while the
 * sign-out is pending. Each test holds a live deals read open and records its
 * signal's state at the moment signOut() is invoked.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
  usePathname: () => '/projects',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/components/brand/Wordmark', () => ({ Wordmark: () => null }));
vi.mock('@/components/wizard/NewMandateDialog', () => ({ NewMandateDialog: () => null }));
vi.mock('swagger-ui-dist', () => ({
  SwaggerUIBundle: Object.assign(vi.fn(), { presets: { apis: {} } }),
}));

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { abortAllReads, sharedRead } from '@/lib/api/inflightRead';
import { ProfileMenu } from '@/components/profile/ProfileMenu';
import { Sidebar } from '@/components/organisms/navigation/Sidebar';
import TwoFactorPageClient from '@/app/two-factor/page.client';
import DevApiPage from '@/app/dev-api/page.client';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';

let heldSignal: AbortSignal | null;
let abortedAtSignOut: boolean | null;

/** A deals read held open, as if the page were still loading the list. */
function holdDealsRead() {
  heldSignal = null;
  void sharedRead(
    'deals',
    (signal) => {
      heldSignal = signal;
      return new Promise<never>(() => {});
    },
    { deadlineMs: 60_000 },
  ).catch(() => {});
  expect(heldSignal).not.toBeNull();
  expect(heldSignal!.aborted).toBe(false);
}

/** signOut() records whether the held read was already aborted when it was called. */
const signOut = vi.fn(async () => {
  abortedAtSignOut = heldSignal?.aborted ?? null;
  return { error: null };
});

function client(extra: Record<string, unknown> = {}) {
  vi.mocked(createSupabaseBrowserClient).mockReturnValue({
    auth: {
      getUser: async () => ({ data: { user: { email: 'md@bank.test' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut,
      ...extra,
    },
  } as never);
}

beforeEach(() => {
  abortedAtSignOut = null;
  signOut.mockClear();
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })),
  );
});

afterEach(() => {
  cleanup();
  abortAllReads();
  vi.unstubAllGlobals();
});

describe('sign-out aborts the in-flight reads before signOut() (#162)', () => {
  it('ProfileMenu', async () => {
    client();
    render(<ProfileMenu name="Storm Duncan" roleLabel="Managing Director" initials="SD" />);
    holdDealsRead();

    fireEvent.click(screen.getByRole('button', { name: /open profile menu/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(abortedAtSignOut).toBe(true);
  });

  it('Sidebar', async () => {
    client();
    const flags = Object.fromEntries(
      (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, false]),
    ) as FlagMap;
    render(
      <FlagsProvider value={flags}>
        <Sidebar collapsed={false} onToggle={() => {}} />
      </FlagsProvider>,
    );
    holdDealsRead();

    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(abortedAtSignOut).toBe(true);
  });

  it('two-factor page', async () => {
    client({
      mfa: {
        getAuthenticatorAssuranceLevel: vi
          .fn()
          .mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null }),
        listFactors: vi.fn().mockResolvedValue({
          data: { all: [], totp: [{ id: 'verified-factor' }] },
          error: null,
        }),
        unenroll: vi.fn(),
        enroll: vi.fn(),
        challenge: vi.fn(),
        verify: vi.fn(),
      },
    });
    render(<TwoFactorPageClient destination="/projects" />);
    await screen.findByLabelText('Six-digit code');
    holdDealsRead();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(abortedAtSignOut).toBe(true);
  });

  it('dev API explorer', async () => {
    client();
    render(<DevApiPage />);
    expect(await screen.findByText('Signed in: md@bank.test')).toBeInTheDocument();
    holdDealsRead();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    expect(abortedAtSignOut).toBe(true);
  });
});

describe('dev API explorer sign-out clears the local stores (#162)', () => {
  it('drops the deal, audit and rail stores like the shell sign-outs do', async () => {
    client();
    window.localStorage.setItem('ib-fixture-deals', '[]');
    window.localStorage.setItem('ib-audit-log', '[{"id":"a"}]');
    window.localStorage.setItem('ib-rail-run:project-summit', '{"uid":"a","receipts":{},"versions":{}}');
    window.sessionStorage.setItem('ib-gate0-receipt:MESAX-2026-462', '{"uid":"a"}');
    render(<DevApiPage />);
    expect(await screen.findByText('Signed in: md@bank.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.localStorage.getItem('ib-fixture-deals')).toBeNull());
    expect(JSON.parse(window.localStorage.getItem('ib-audit-log') ?? '[]')).toEqual([]);
    expect(window.localStorage.getItem('ib-rail-run:project-summit')).toBeNull();
    expect(window.sessionStorage.getItem('ib-gate0-receipt:MESAX-2026-462')).toBeNull();
  });
});
