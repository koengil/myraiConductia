import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ConnectResult } from '@/app/(authed)/profile/ConnectResult';

const nav = vi.hoisted(() => ({ search: '', pathname: '/profile', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => nav.pathname,
}));

const flag = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: () => flag.on }));

const setFlash = () => {
  document.cookie = 'cw_connected=1; Path=/';
};
beforeEach(() => {
  nav.pathname = '/profile';
  nav.replace.mockReset();
  flag.on = true;
  document.cookie = 'cw_connected=; Max-Age=0; Path=/';
});

describe('ConnectResult', () => {
  it('shows the result in Settings › Profile, where /profile redirects, and keeps the section', () => {
    setFlash();
    nav.pathname = '/settings';
    nav.search = '?section=profile&connected=1';
    render(<ConnectResult />);
    expect(screen.getByRole('status')).toHaveTextContent('Work account connected');
    expect(nav.replace).toHaveBeenCalledWith('/settings?section=profile', { scroll: false });
  });

  it('shows success once for connected=1 with the callback cookie, then clears both', () => {
    setFlash();
    nav.search = '?connected=1';
    const { unmount } = render(<ConnectResult />);
    expect(screen.getByRole('status')).toHaveTextContent('Work account connected');
    expect(nav.replace).toHaveBeenCalledWith('/profile', { scroll: false });
    expect(document.cookie).not.toContain('cw_connected=1');
    unmount();
    render(<ConnectResult />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the success under StrictMode, whose second effect run finds the cookie spent', () => {
    setFlash();
    nav.search = '?connected=1';
    render(
      <React.StrictMode>
        <ConnectResult />
      </React.StrictMode>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Work account connected');
  });

  it('shows nothing for a crafted or replayed connected=1 without the cookie', () => {
    nav.search = '?connected=1';
    render(<ConnectResult />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows nothing and leaves the URL alone with the flag off', () => {
    flag.on = false;
    nav.search = '?error=mfa_required';
    render(<ConnectResult />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('clears only the result keys, keeping the rest of the query', () => {
    nav.search = '?tab=security&connected=1';
    render(<ConnectResult />);
    expect(nav.replace).toHaveBeenCalledWith('/profile?tab=security', { scroll: false });
  });

  it('treats any other connected value as no result', () => {
    nav.search = '?connected=0';
    render(<ConnectResult />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses connect wording, never invitation wording', () => {
    nav.search = '?error=consent_canceled';
    render(<ConnectResult />);
    expect(screen.getByRole('status')).toHaveTextContent('Connection was canceled');
    expect(screen.getByRole('status')).not.toHaveTextContent(/invitation/i);
  });

  it('shows the generic connect failure for a code outside the connect flow', () => {
    nav.search = '?error=account_suspended';
    render(<ConnectResult />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your work account provider did not complete the connection',
    );
  });

  it.each(['__proto__', 'constructor', 'toString'])('treats the prototype key %s as a generic failure', (code) => {
    nav.search = `?error=${code}`;
    render(<ConnectResult />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your work account provider did not complete the connection',
    );
  });

  it('renders nothing and leaves the URL alone without a result', () => {
    nav.search = '';
    render(<ConnectResult />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
