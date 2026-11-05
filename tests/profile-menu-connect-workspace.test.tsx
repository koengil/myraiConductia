import { describe, expect, it, vi } from 'vitest';
import { afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProfileMenu } from '@/components/profile/ProfileMenu';
import { workIdentityErrorCopy } from '@/lib/auth/workIdentityCopy';
import { WORK_IDENTITY_ERROR } from '@/lib/constants/workIdentity';

const flag = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: () => flag.on }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
const auth = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({ auth }),
}));

function open() {
  render(<ProfileMenu name="Storm Duncan" roleLabel="Administrator" initials="SD" compact />);
  fireEvent.click(screen.getByRole('button', { name: /open profile menu/ }));
}

let provider: string | null = 'google';
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ provider }), { status: 200 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('ProfileMenu connect work account', () => {
  it.each([
    ['google', 'Connect Google Workspace'],
    ['azure', 'Connect Microsoft'],
  ])('offers the firm provider %s, returning to /profile', async (p, label) => {
    flag.on = true;
    provider = p;
    open();
    expect(await screen.findByRole('link', { name: label })).toHaveAttribute(
      'href',
      `/auth/work/connect?provider=${p}&redirectTo=%2Fprofile`,
    );
  });

  it('offers nothing when the firm has no provider', async () => {
    flag.on = true;
    provider = null;
    open();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /^Connect/ })).toBeNull();
  });

  it('hides the entry and skips the lookup when the flag is off', () => {
    flag.on = false;
    open();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /^Connect/ })).toBeNull();
  });

  it('tells an unconnected sign-in how to connect, with a path for users without a password', () => {
    const copy = workIdentityErrorCopy(WORK_IDENTITY_ERROR.NOT_CONNECTED);
    expect(copy.recovery).toBe('ask_resend');
    expect(copy.message).toMatch(/connect it from the profile menu/);
    expect(copy.message).toMatch(/ask your firm administrator/);
    expect(copy.message).not.toMatch(/Google|Microsoft/);
  });

  it('retries the lookup on the next open after a failed read', async () => {
    flag.on = true;
    provider = 'google';
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 503 }));
    open();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0)); // let the failed read settle
    expect(screen.queryByRole('link', { name: /^Connect/ })).toBeNull();
    const trigger = screen.getByRole('button', { name: /profile menu/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByRole('link', { name: 'Connect Google Workspace' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('drops the provider on close, so a reopen never offers a stale one while it re-reads', async () => {
    flag.on = true;
    provider = 'google';
    open();
    expect(await screen.findByRole('link', { name: 'Connect Google Workspace' })).toBeInTheDocument();
    let release: (r: Response) => void = () => {};
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    const trigger = screen.getByRole('button', { name: /profile menu/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('link', { name: /^Connect/ })).toBeNull();
    // The row is held while the read is in flight, so Sign out does not move.
    expect(screen.getByTestId('connect-placeholder')).toBeInTheDocument();
    release(new Response(JSON.stringify({ provider: 'azure' }), { status: 200 }));
    expect(await screen.findByRole('link', { name: 'Connect Microsoft' })).toBeInTheDocument();
    expect(screen.queryByTestId('connect-placeholder')).toBeNull();
  });

  it('settles a hung provider read at the deadline, freeing the reserved row', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      flag.on = true;
      vi.mocked(fetch).mockImplementationOnce(
        (_url, init) =>
          new Promise<Response>((_r, reject) =>
            (init?.signal as AbortSignal).addEventListener('abort', () => reject(new Error('timeout'))),
          ),
      );
      open();
      expect(screen.getByTestId('connect-placeholder')).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(5000);
      await vi.waitFor(() => expect(screen.queryByTestId('connect-placeholder')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers nothing for a provider value outside the known set', async () => {
    flag.on = true;
    provider = 'constructor';
    open();
    await vi.waitFor(() => expect(screen.queryByTestId('connect-placeholder')).toBeNull());
    expect(screen.queryByRole('link', { name: /^Connect/ })).toBeNull();
  });

  it('re-reads on each open, so a provider configured mid-session appears', async () => {
    flag.on = true;
    provider = null;
    open();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('link', { name: /^Connect/ })).toBeNull();
    provider = 'azure';
    const trigger = screen.getByRole('button', { name: /profile menu/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByRole('link', { name: 'Connect Microsoft' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a lookup aborted by a failed sign-out does not block later opens', async () => {
    flag.on = true;
    provider = 'google';
    // First read hangs until aborted.
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          (init as RequestInit).signal!.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
        ),
    );
    auth.signOut.mockRejectedValueOnce(new Error('network'));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('Could not sign out. Try again.');
    const trigger = screen.getByRole('button', { name: /profile menu/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByRole('link', { name: 'Connect Google Workspace' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not fetch until the menu opens', () => {
    flag.on = true;
    render(<ProfileMenu name="Storm Duncan" roleLabel="Administrator" initials="SD" compact />);
    expect(fetch).not.toHaveBeenCalled();
  });
});
