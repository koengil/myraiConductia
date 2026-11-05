import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';

import { initialsFor, initialsFromEmail, useCurrentUser } from '@/lib/auth/useCurrentUser';

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { email: 'roberto@conductia.com' } } }),
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useCurrentUser', () => {
  it('loads the signed-in profile from /api/v1/me', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              user: {
                id: 'u-rob',
                email: 'roberto@conductia.com',
                full_name: 'Roberto Di Lillo',
                display_name: 'Rob',
                firm_role: null,
                department: 'admin',
                is_external: false,
                status: 'active',
                company_id: 'co-1',
                company_role: 'member',
                can_invite: true,
              },
              company: { id: 'co-1', name: 'Conductia' },
              mandate: null,
            }),
        }),
      ),
    );

    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.user.full_name).toBe('Roberto Di Lillo');
    expect(result.current.state.data.user.email).toBe('roberto@conductia.com');
  });

  it('errors without impersonating the sandbox Storm persona when /me fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Server misconfigured' }),
        }),
      ),
    );

    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(JSON.stringify(result.current.state)).not.toMatch(/Storm Duncan/i);
    expect(JSON.stringify(result.current.state)).not.toMatch(/intelibank\.dev/i);
    expect(JSON.stringify(result.current.state)).not.toMatch(/Atlassian/i);
  });
});

describe('avatar initials', () => {
  it('uses the email local-part when no name is set', () => {
    expect(initialsFromEmail('roberto.dilillo@conductia.com')).toBe('RD');
    expect(
      initialsFor({
        id: 'u1',
        email: 'roberto.dilillo@conductia.com',
        full_name: '',
        display_name: null,
        firm_role: null,
        department: null,
        is_external: false,
        status: 'active',
        company_id: null,
        company_role: null,
        can_invite: false,
      }),
    ).toBe('RD');
  });
});

describe('useCurrentUser revalidation', () => {
  const profile = {
    id: 'u-martin',
    email: 'martin@conductia.com',
    full_name: 'Martin',
    display_name: null,
    firm_role: null,
    department: 'admin',
    is_external: false,
    status: 'active',
    company_id: 'co-1',
    company_role: 'member',
    can_invite: false,
  };
  const leadsView = { permissionKey: 'company:leads:view', source: { type: 'member' } };

  it('re-reads /me when the tab regains focus so a revoked permission drops out', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ user: profile, company: null, mandate: null, company_permissions: [leadsView] }),
      })
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ user: profile, company: null, mandate: null, company_permissions: [] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.company_permissions).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    // Silent: the last answer stays on screen while the fresh one is in flight.
    expect(result.current.state.status).toBe('ready');

    await waitFor(() => {
      if (result.current.state.status !== 'ready') throw new Error('expected ready');
      expect(result.current.state.data.company_permissions).toHaveLength(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the signed-in user when a focus revalidation fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ user: profile, company: null, mandate: null, company_permissions: [leadsView] }),
      })
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'down' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.company_permissions).toHaveLength(1);
  });

  it('never lets a slow focus revalidation overwrite a reload that started after it', async () => {
    let releaseSlow: (value: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const answer = (fullName: string) => ({
      ok: true,
      json: () => Promise.resolve({ user: { ...profile, full_name: fullName }, company: null, mandate: null }),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer('OLD'))
      .mockImplementationOnce(() => slow.then(() => answer('OLD')))
      .mockResolvedValueOnce(answer('NEW'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCurrentUser());
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await result.current.reload();
    });
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.user.full_name).toBe('NEW');

    await act(async () => {
      releaseSlow(undefined);
      await slow;
    });
    if (result.current.state.status !== 'ready') throw new Error('expected ready');
    expect(result.current.state.data.user.full_name).toBe('NEW');
  });
});
