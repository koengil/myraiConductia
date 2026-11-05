import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import { useSkipApprovers } from '@/lib/rail/useSkipApprovers';

const { useCompanyMembersMock } = vi.hoisted(() => ({ useCompanyMembersMock: vi.fn() }));

vi.mock('@/lib/company/useCompanyMembers', () => ({ useCompanyMembers: useCompanyMembersMock }));

const COMPANY = {
  status: 'ready' as const,
  members: [{ id: 'sd', name: 'Storm Duncan', role: 'Managing Director' }],
};

beforeEach(() => {
  useCompanyMembersMock.mockReturnValue(COMPANY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useSkipApprovers (#312)', () => {
  it('on a fixture deal returns the company roster and calls no API', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useSkipApprovers({ dealId: 'atlassian', stepKey: 'p1-s10', live: false }),
    );

    expect(result.current).toBe(COMPANY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on a live deal lists only active md, deal_team and legal seats from the step GET', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        members: [
          { id: 'u-md', name: 'Storm Duncan', dealRole: 'md', status: 'active' },
          { id: 'u-team', name: 'Avery Lindqvist', dealRole: 'deal_team', status: 'active' },
          { id: 'u-gone', name: 'Sid Suspended', dealRole: 'deal_team', status: 'suspended' },
          { id: 'u-new', name: 'Ivy Invited', dealRole: 'legal', status: 'invited' },
          { id: 'u-legal', name: 'Priya Mehta', dealRole: 'legal', status: 'active' },
          { id: 'u-ro', name: 'Olive Observer', dealRole: 'read_only', status: 'active' },
          { id: 'u-buyer', name: 'Bea Buyer', dealRole: 'buyer', status: 'active' },
          { id: 'u-seller', name: 'Sam Seller', dealRole: 'seller', status: 'active' },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useSkipApprovers({ dealId: 'deal-1', stepKey: 'custom:abc', live: true }),
    );

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.members).toEqual([
      { id: 'u-md', name: 'Storm Duncan', role: 'Managing Director' },
      { id: 'u-team', name: 'Avery Lindqvist', role: 'Deal Team' },
      { id: 'u-legal', name: 'Priya Mehta', role: 'Legal Counsel' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/v1/deals/deal-1/steps/custom%3Aabc',
      expect.objectContaining({ credentials: 'include' }),
    ]);
  });

  it('on a live deal reports an error when the step GET fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) })),
    );

    const { result } = renderHook(() =>
      useSkipApprovers({ dealId: 'deal-1', stepKey: 'p1-s10', live: true }),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.members).toEqual([]);
  });
});
