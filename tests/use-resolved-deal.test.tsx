import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

import { useResolvedDeal, type ResolvedDeal } from '../src/lib/deals/useDeals';
import { abortAllReads } from '../src/lib/api/inflightRead';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '../src/lib/flags/keys';
import type { FlagMap } from '../src/lib/flags/resolveFlags';

/*
 * #162 Phase 3: a deal is never reported "not found", and never resolved to a
 * seed fixture, because its deal list failed to load. useResolvedDeal checks
 * the list error first and offers a retry.
 */

function wrapper(platformOnboarding: boolean) {
  const value = {
    ...(Object.fromEntries(
      (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, false]),
    ) as FlagMap),
    gate0_api_create: true,
    platform_onboarding: platformOnboarding,
  };
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <FlagsProvider value={value}>{children}</FlagsProvider>;
  }
  return Wrapper;
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

const API_DEAL = {
  id: 'uuid-mesa',
  code: 'MESAX-2026-462',
  codename: 'Project Mesa',
  status: 'active',
  createdAt: '2026-07-15T00:00:00Z',
  entryStepSeq: 12,
  currentStepSeq: 12,
  targetName: null,
  dealRole: 'md',
  conflictsApprovedBy: null,
  conflictsApprovedOn: null,
};

afterEach(() => {
  cleanup();
  abortAllReads();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('useResolvedDeal (#162)', () => {
  it('a failed list resolves to "error", not "unknown"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));
    const { result } = renderHook(() => useResolvedDeal('MESAX-2026-462'), {
      wrapper: wrapper(true),
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.status).not.toBe('unknown');
  });

  it('platform onboarding, list failed, a seed fixture segment: "error", never "ready"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));
    const seen: ResolvedDeal['status'][] = [];
    const { result } = renderHook(
      () => {
        const resolved = useResolvedDeal('project-summit');
        seen.push(resolved.status);
        return resolved;
      },
      { wrapper: wrapper(true) },
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(seen).not.toContain('ready');
  });

  it('platform onboarding, list loaded without it: a seed fixture segment is "unknown", never a fixture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ deals: [API_DEAL] })));
    const { result } = renderHook(() => useResolvedDeal('project-summit'), {
      wrapper: wrapper(true),
    });

    await waitFor(() => expect(result.current.status).toBe('unknown'));
  });

  it('retry goes resolving, then ready', async () => {
    let fail = true;
    let release!: () => void;
    const fetchMock = vi.fn(() => {
      if (fail) return Promise.resolve(json({ error: 'boom' }, 503));
      return new Promise<Response>((resolve) => {
        release = () => resolve(json({ deals: [API_DEAL] }));
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useResolvedDeal('MESAX-2026-462'), {
      wrapper: wrapper(true),
    });
    await waitFor(() => expect(result.current.status).toBe('error'));

    fail = false;
    const current = result.current;
    if (current.status !== 'error') throw new Error('expected the error state');
    act(() => current.retry());
    expect(result.current.status).toBe('resolving');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => release());
    expect(result.current).toMatchObject({ status: 'ready', deal: { codename: 'Project Mesa' } });
  });
});
