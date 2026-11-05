import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useCompanyMembers } from '@/lib/company/useCompanyMembers';

const { useFlagMock, useCurrentUserMock } = vi.hoisted(() => ({
  useFlagMock: vi.fn(),
  useCurrentUserMock: vi.fn(),
}));

vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: useFlagMock }));
vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: useCurrentUserMock,
}));

beforeEach(() => {
  useCurrentUserMock.mockReturnValue({
    state: {
      status: 'ready',
      data: { user: { company_id: 'co-bank' } },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useCompanyMembers', () => {
  it('returns fixture colleagues when the API flag is off', async () => {
    useFlagMock.mockReturnValue(false);

    const { result } = renderHook(() => useCompanyMembers());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.members.some((m) => m.name === 'Storm Duncan')).toBe(true);
  });

  it('stays loading until the signed-in user profile is ready', () => {
    useFlagMock.mockReturnValue(true);
    useCurrentUserMock.mockReturnValue({ state: { status: 'loading' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCompanyMembers());

    expect(result.current.status).toBe('loading');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('errors when the signed-in profile cannot be loaded', () => {
    useFlagMock.mockReturnValue(true);
    useCurrentUserMock.mockReturnValue({ state: { status: 'error' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCompanyMembers());

    expect(result.current.status).toBe('error');
    expect(result.current.members).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads company members from the platform API when the flag is on', async () => {
    useFlagMock.mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              members: [
                {
                  id: 'u-1',
                  full_name: 'Rob Admin',
                  display_name: null,
                  email: 'rob@bank.test',
                  department: 'ib',
                  company_role: 'director',
                  preferred_deal_role: 'md',
                },
              ],
            }),
        }),
      ),
    );

    const { result } = renderHook(() => useCompanyMembers());

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.members).toEqual([
      { id: 'u-1', name: 'Rob Admin', role: 'Managing Director' },
    ]);
    expect(fetch).toHaveBeenCalledWith('/api/v1/companies/co-bank/members', expect.any(Object));
  });
});
