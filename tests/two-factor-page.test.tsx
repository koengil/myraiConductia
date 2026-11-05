import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { replace, refresh } = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh }),
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('@/components/brand/Wordmark', () => ({ Wordmark: () => null }));

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import TwoFactorPageClient from '@/app/two-factor/page.client';

function mfaClient(options: {
  factors?: {
    all: Array<Record<string, unknown>>;
    totp: Array<{ id: string; friendly_name?: string }>;
  };
  verifyError?: object | null;
  challengeError?: object | null;
} = {}) {
  const assurance = vi
    .fn()
    .mockResolvedValueOnce({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    .mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
  const listFactors = vi.fn().mockResolvedValue({
    data: options.factors ?? { all: [], totp: [] },
    error: null,
  });
  const unenroll = vi.fn().mockResolvedValue({ data: {}, error: null });
  const enroll = vi.fn().mockResolvedValue({
    data: {
      id: 'new-factor',
      totp: { qr_code: '<svg></svg>', secret: 'ABCD EFGH' },
    },
    error: null,
  });
  const challenge = vi.fn().mockResolvedValue({
    data: { id: 'challenge-1' },
    error: options.challengeError ?? null,
  });
  const verify = vi.fn().mockResolvedValue({
    data: {},
    error: options.verifyError ?? null,
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });

  vi.mocked(createSupabaseBrowserClient).mockReturnValue({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: assurance,
        listFactors,
        unenroll,
        enroll,
        challenge,
        verify,
      },
      signOut,
    },
  } as never);

  return { assurance, listFactors, unenroll, enroll, challenge, verify, signOut };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => vi.unstubAllGlobals());

describe('two-factor completion page', () => {
  it('clears a stale enrollment, displays the new QR secret, verifies, audits, and continues', async () => {
    const client = mfaClient({
      factors: {
        all: [
          {
            id: 'stale-factor',
            factor_type: 'totp',
            status: 'unverified',
          },
        ],
        totp: [],
      },
    });

    render(<TwoFactorPageClient destination="/projects/rangers?tab=mail" />);

    expect(await screen.findByText('ABCD EFGH')).toBeInTheDocument();
    expect(client.unenroll).toHaveBeenCalledWith({ factorId: 'stale-factor' });
    expect(client.enroll).toHaveBeenCalledWith({
      factorType: 'totp',
      friendlyName: 'Conductia authenticator',
    });

    fireEvent.change(screen.getByLabelText('Six-digit code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects/rangers?tab=mail'));
    expect(client.challenge).toHaveBeenCalledWith({ factorId: 'new-factor' });
    expect(client.verify).toHaveBeenCalledWith({
      factorId: 'new-factor',
      challengeId: 'challenge-1',
      code: '123456',
    });
    expect(fetch).toHaveBeenCalledWith('/api/v1/auth/mfa/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'mfa_enrolled' }),
    });
  });

  it('exposes the manual setup key under a stable test id', async () => {
    // Reuses the file's default enrollment mock above, whose secret ('ABCD EFGH')
    // is a base32 string.
    mfaClient({
      factors: { all: [], totp: [] },
    });

    render(<TwoFactorPageClient destination="/projects/ATLAS" />);

    const secret = await screen.findByTestId('mfa-manual-secret');
    expect(secret).toHaveTextContent(/^[A-Z2-7 ]+$/);
  });

  it('uses a verified factor and keeps an invalid code on the page for retry', async () => {
    const client = mfaClient({
      factors: {
        all: [],
        totp: [{ id: 'verified-factor', friendly_name: 'Primary authenticator' }],
      },
      verifyError: { message: 'expired code' },
    });

    render(<TwoFactorPageClient destination="/projects" />);
    const input = await screen.findByLabelText('Six-digit code');
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('code was not accepted');
    expect(input).toHaveValue('');
    expect(client.challenge).toHaveBeenCalledWith({ factorId: 'verified-factor' });
    expect(fetch).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('surfaces a failed audit write and retries it without repeating factor verification', async () => {
    const client = mfaClient({
      factors: { all: [], totp: [{ id: 'verified-factor' }] },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false } as Response)
      .mockResolvedValueOnce({ ok: true } as Response);

    render(<TwoFactorPageClient destination="/projects" />);
    fireEvent.change(await screen.findByLabelText('Six-digit code'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('security record could not be saved');
    fireEvent.click(screen.getByRole('button', { name: 'Retry the security record' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.verify).toHaveBeenCalledTimes(1);
  });

  it('clears the partial session before returning to sign-in', async () => {
    const client = mfaClient({
      factors: { all: [], totp: [{ id: 'verified-factor' }] },
    });
    render(<TwoFactorPageClient destination="/projects" />);
    await screen.findByLabelText('Six-digit code');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(client.signOut).toHaveBeenCalledOnce());
    expect(replace).toHaveBeenCalledWith('/sign-in');
  });
});
