import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }));

vi.mock('@supabase/ssr', () => ({ createServerClient }));
vi.mock('@/lib/supabase/config', () => ({
  getSupabaseConfig: () => ({ url: 'https://supabase.test', publishableKey: 'public-key' }),
}));

import { middleware } from '@/middleware';

function authState(user: object | null) {
  createServerClient.mockReturnValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn().mockResolvedValue({
          data: { currentLevel: 'aal1', nextLevel: 'aal2' },
          error: null,
        }),
      },
    },
  });
}

// A legacy link that put a person and a search term in the URL (#331).
const LEGACY = 'https://app.test/projects/p1/team?person=Jane+Doe&q=secret&tab=x&Subject=Falcon+Memo';

beforeEach(() => vi.clearAllMocks());

describe('middleware redirects drop free-text query keys (#331)', () => {
  it.each([
    ['sign-in', null, '/sign-in'],
    ['two-factor', { id: 'user-1' }, '/two-factor'],
  ])('the %s redirect replays neither the person nor the search term', async (_label, user, pathname) => {
    authState(user);
    const response = await middleware(new NextRequest(LEGACY));
    const raw = response.headers.get('location')!;
    const location = new URL(raw);
    expect(location.pathname).toBe(pathname);
    for (const leaked of ['Jane', 'secret', 'Falcon']) {
      expect(raw).not.toContain(leaked);
      expect(decodeURIComponent(raw)).not.toContain(leaked);
    }
    expect(location.searchParams.get('redirectTo')).toBe('/projects/p1/team?tab=x');
  });

  it('leaves a destination without free-text keys as it was', async () => {
    authState(null);
    const response = await middleware(new NextRequest('https://app.test/projects/p1/team?tab=x&view=compact'));
    expect(new URL(response.headers.get('location')!).searchParams.get('redirectTo')).toBe(
      '/projects/p1/team?tab=x&view=compact',
    );
  });

  it('drops the query entirely when every key is free text', async () => {
    authState(null);
    const response = await middleware(new NextRequest('https://app.test/projects/p1?NAME=Jane'));
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('redirectTo')).toBe('/projects/p1');
    expect([...location.searchParams.keys()]).toEqual(['redirectTo']);
  });
});
