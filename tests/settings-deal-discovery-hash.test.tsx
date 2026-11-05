import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

import { DealDiscoveryHashRedirect } from '@/components/settings/DealDiscoveryHashRedirect';
import { profileRedirectTarget } from '@/lib/settings/href';

function at(search: string, hash: string) {
  window.history.replaceState(null, '', `/settings${search}${hash}`);
}

beforeEach(() => replace.mockClear());
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('old /profile#deal-discovery links', () => {
  it('move from Settings › Profile to Settings › Mail, keeping the hash', () => {
    at('?section=profile', '#deal-discovery');
    render(<DealDiscoveryHashRedirect enabled />);
    expect(replace).toHaveBeenCalledWith('/settings?section=mail#deal-discovery');
  });

  it('keep ?connected= and ?error= on the way', () => {
    at('?section=profile&connected=google', '#deal-discovery');
    render(<DealDiscoveryHashRedirect enabled />);
    expect(replace).toHaveBeenCalledWith('/settings?section=mail&connected=google#deal-discovery');
    cleanup();
    replace.mockClear();
    at('?section=profile&error=access_denied', '#deal-discovery');
    render(<DealDiscoveryHashRedirect enabled />);
    expect(replace).toHaveBeenCalledWith('/settings?section=mail&error=access_denied#deal-discovery');
  });

  it('do nothing without the hash, or where Mail is not offered', () => {
    at('?section=profile', '');
    render(<DealDiscoveryHashRedirect enabled />);
    cleanup();
    at('?section=profile', '#deal-discovery');
    render(<DealDiscoveryHashRedirect enabled={false} />);
    expect(replace).not.toHaveBeenCalled();
  });

  it('leave the server redirect carrying ?connected= and ?error=', () => {
    expect(profileRedirectTarget({ connected: 'google', error: undefined })).toBe(
      '/settings?section=profile&connected=google',
    );
    expect(profileRedirectTarget({ error: 'access_denied' })).toBe('/settings?section=profile&error=access_denied');
  });
});
