import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as lookup } from '@/app/api/v1/invites/lookup/route';
import { POST as preview } from '@/app/api/v1/invites/perimeter-preview/route';

/**
 * D8.15 / criterion D1: with `platform_onboarding` off, none of this work is
 * reachable and every surface it touches behaves exactly as it did before.
 *
 * The routes are checked here; the UI surfaces mount their cards inside
 * flag-gated trees that already have flag-off coverage
 * (`gate0-wizard-api`, `team-roster-live`, `external-deal-home`), and the
 * full suite passing with the flag unset is itself the parity evidence.
 */

const requireFlag = vi.fn();
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: (...args: unknown[]) => requireFlag(...args),
}));

const requireApiUser = vi.fn();
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return { ...actual, requireApiUser: () => requireApiUser() };
});

function post(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Flag off: `requireFlag` returns the 404 response, exactly as it does for
  // every other route added behind this flag.
  requireFlag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
  requireApiUser.mockResolvedValue({ ok: true, user: { id: 'md-1' }, admin: {} });
});

describe('flag off — the new routes do not exist (D1, D8.15)', () => {
  it('lookup returns 404, not 401 or 403', async () => {
    const res = await lookup(post('http://x/api/v1/invites/lookup', { email: 'a@b.com' }));
    expect(res.status).toBe(404);
  });

  it('perimeter preview returns 404', async () => {
    const res = await preview(
      post('http://x/api/v1/invites/perimeter-preview', {
        proposal: { email: 'a@b.com', companyId: 'c1', phase: 0 },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('answers 404 before authenticating, so an unauthenticated prober cannot tell the routes apart from any other missing path', async () => {
    await lookup(post('http://x/api/v1/invites/lookup', { email: 'a@b.com' }));
    await preview(
      post('http://x/api/v1/invites/perimeter-preview', {
        member: { dealId: 'd1', userId: 'u1', phase: 2 },
      }),
    );
    expect(requireApiUser).not.toHaveBeenCalled();
  });

  it('gates on platform_onboarding specifically', async () => {
    await lookup(post('http://x/api/v1/invites/lookup', { email: 'a@b.com' }));
    expect(requireFlag).toHaveBeenCalledWith('platform_onboarding');
  });

  it('reads no request body before the flag check', async () => {
    // A malformed body still yields 404, not 400: nothing about the route's
    // contract leaks while it is switched off.
    const res = await lookup(
      new Request('http://x/api/v1/invites/lookup', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(404);
  });
});
