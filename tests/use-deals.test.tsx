import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import * as React from 'react';

import {
  dealListSource,
  dealMatchesSegment,
  findDealBySegment,
  mapApiDeal,
  pendingDealForCode,
  resolveActiveDeal,
  useActiveDeal,
  useActiveDealState,
  useDeals,
} from '../src/lib/deals/useDeals';
import { RAIL_LOAD_DEADLINE_MS } from '../src/lib/rail/railLoadStage';
import { abortAllReads } from '../src/lib/api/inflightRead';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import type { FlagMap } from '../src/lib/flags/resolveFlags';
import { stepIdForSeq } from '../src/lib/rail/dealRail';
import { DEALS_EVENT, clearStoredDeals, createDeal } from '../src/lib/rail/deals';

function flagsWrapper(on: boolean, platformOnboarding = false) {
  const value: FlagMap = {
    rail_templates: false,
    template_change_review: false,
    deal_data_room_nav: false,
    gate0_api_create: on,
    platform_onboarding: platformOnboarding,
    work_identity_onboarding: false,
    mail_channel: false,
    mail_jev_second_opinion: false,
    teaser_sandbox_runner: false,
    company_access_management: false,
    setup_walkthroughs: false,
    book_view: false,
    project_rail_model: false,
    deal_discovery: false,
    discovery_worker_enabled: false,
    discovery_model_proposals_demo: false,
    workbench_top_nav: false,
    skill_authoring: false,
    skill_output_revisions: false,
  };
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <FlagsProvider value={value}>{children}</FlagsProvider>;
  }
  Wrapper.displayName = 'FlagsTestWrapper';
  return Wrapper;
}

afterEach(() => {
  cleanup();
  // The in-flight coordinator is module state: a read a test left pending
  // must not be joined by the next test.
  abortAllReads();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('dealMatchesSegment', () => {
  const ember = mapApiDeal({
    id: '6f1c2a9e-1111-4c4c-8d8d-000000000001',
    code: 'EMBER-2026-002',
    codename: 'Project Ember',
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    entryStepSeq: 1,
    currentStepSeq: 1,
    targetName: null,
    dealRole: 'md',
    conflictsApprovedBy: null,
    conflictsApprovedOn: null,
  });

  it('matches the deal by its uuid, its code and its routing id', () => {
    expect(dealMatchesSegment(ember, '6f1c2a9e-1111-4c4c-8d8d-000000000001')).toBe(true);
    expect(dealMatchesSegment(ember, 'EMBER-2026-002')).toBe(true);
    expect(dealMatchesSegment(ember, ember.id)).toBe(true);
  });

  it('matches nothing else', () => {
    expect(dealMatchesSegment(ember, 'SUMMIT-2026-003')).toBe(false);
    expect(dealMatchesSegment(ember, '6f1c2a9e-1111-4c4c-8d8d-000000000002')).toBe(false);
    expect(dealMatchesSegment(ember, '')).toBe(false);
  });

  it('a uuid route resolves the deal by name, never the uuid', () => {
    expect(findDealBySegment([ember], '6f1c2a9e-1111-4c4c-8d8d-000000000001')?.codename).toBe('Project Ember');
  });
});

describe('mapApiDeal', () => {
  it('routes by code, flattens the target, and derives the cursor from the step seq', () => {
    const mapped = mapApiDeal({
      id: 'uuid-1',
      code: 'SUM-2026-014',
      codename: 'Project Summit',
      status: 'intake',
      createdAt: '2026-07-15T00:00:00Z',
      entryStepSeq: 12,
      currentStepSeq: 12,
      targetName: 'Databricks',
      dealRole: 'md',
      conflictsApprovedBy: 'Avery Lindqvist',
      conflictsApprovedOn: '2026-07-14',
      targetCloseDate: '2026-10-09',
      feeUsd: 5_100_000,
      scheduleStatus: 'ahead',
      lifecycleCategory: 'pitch',
    });
    expect(mapped.id).toBe('SUM-2026-014'); // route by code, never the UUID or target
    expect(mapped.targetCloseDate).toBe('2026-10-09');
    expect(mapped.feeUsd).toBe(5_100_000);
    expect(mapped.scheduleStatus).toBe('ahead');
    expect(mapped.lifecycleCategory).toBe('pitch');
    expect(mapped.code).toBe('SUM-2026-014');
    expect(mapped.target).toBe('Databricks');
    expect(mapped.cursorStepId).toBe(stepIdForSeq(12));
    expect(mapped.entryStepSeq).toBe(12);
    // COMPLIANCE: the routing id must never be the target company name.
    expect(mapped.id.toLowerCase()).not.toContain('databricks');
  });

  it('falls back to the codename when no target is joined', () => {
    const mapped = mapApiDeal({
      id: 'uuid-2',
      code: 'HAR-2026-021',
      codename: 'Project Harbor',
      status: 'active',
      createdAt: '2026-07-15T00:00:00Z',
      entryStepSeq: 1,
      currentStepSeq: 1,
      targetName: null,
      dealRole: null,
      conflictsApprovedBy: null,
      conflictsApprovedOn: null,
      targetCloseDate: null,
    });
    expect(mapped.target).toBe('Project Harbor');
    expect(mapped.dealRole).toBe('Member');
    expect(mapped.targetCloseDate).toBeNull();
    // Absent in the payload (older API) maps to null, never undefined.
    expect(mapped.feeUsd).toBeNull();
    expect(mapped.scheduleStatus).toBeNull();
    // The category is never null: absent maps to the column default.
    expect(mapped.lifecycleCategory).toBe('live');
  });
});

describe('resolveActiveDeal', () => {
  it('matches the URL segment by deal code when id is a slug', () => {
    const deals = [
      {
        id: 'project-palette',
        codename: 'Project Palette',
        code: 'PALET-2026-497',
        target: 'Acme',
        sector: '',
        status: 'Intake',
        cursorStepId: 'p1-s1',
        entryStepSeq: 1,
        gate0Complete: true,
        dealRole: 'Managing Director',
      },
    ] as const;

    const resolved = resolveActiveDeal('PALET-2026-497', deals, dealListSource(false, false));
    expect(resolved?.codename).toBe('Project Palette');
  });

  it('returns a pending placeholder for real codes while the API list is still empty', () => {
    const resolved = resolveActiveDeal('PALET-2026-497', [], dealListSource(true, false));
    expect(resolved?.id).toBe('PALET-2026-497');
    expect(resolved?.codename).toBe('PALET-2026-497');
  });
});

describe('useActiveDeal', () => {
  it('never falls back to a seed deal when API create is on and the code is unknown', () => {
    const { result } = renderHook(() => useActiveDeal('FALCO-2026-041'), {
      wrapper: flagsWrapper(true),
    });
    expect(result.current.codename).toBe('FALCO-2026-041');
    expect(result.current.codename.toLowerCase()).not.toContain('summit');
  });
});

describe('pendingDealForCode (G22)', () => {
  it('shows the code as identity, never a seed deal name', () => {
    const d = pendingDealForCode('SUM-2026-014');
    expect(d.id).toBe('SUM-2026-014');
    expect(d.codename).toBe('SUM-2026-014');
    expect(d.code).toBe('SUM-2026-014');
    expect(d.target).toBe('');
    // Never Project Summit / another deal's identity.
    expect(d.codename.toLowerCase()).not.toContain('summit');
  });
});

describe('useDeals', () => {
  it('flag ON: does NOT flash the seed deals while loading (G24)', () => {
    // A fetch that never resolves keeps the hook in its loading state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true) });
    // No fixture flash: the list is empty, not SEED_DEALS, until the API answers.
    expect(result.current.state.status).toBe('loading');
    expect(result.current.loading).toBe(true);
    expect(result.current.deals).toHaveLength(0);
  });

  it('flag OFF: is never "loading", not even on the first render — the fixtures ARE the data', () => {
    // Effects flush inside renderHook, so `result.current` alone would pass
    // vacuously; capture what the FIRST render handed the consumer.
    const firstRender: { loading: boolean; deals: number }[] = [];
    renderHook(
      () => {
        const r = useDeals();
        firstRender.push({ loading: r.loading, deals: r.deals.length });
        return r;
      },
      { wrapper: flagsWrapper(false) },
    );
    expect(firstRender[0]).toEqual({ loading: false, deals: expect.any(Number) });
    expect(firstRender[0].deals).toBeGreaterThan(0);
  });

  it('flag OFF: returns the fixture deal set (no fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(false) });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    // Seed deals are always present in the fixture set.
    expect(result.current.deals.some((d) => d.id === 'project-summit')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('flag ON: fetches /api/v1/deals and maps the rows', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            deals: [
              {
                id: 'uuid-1',
                code: 'PROJ-2026-999',
                codename: 'Project Falcon',
                status: 'intake',
                createdAt: '2026-07-15T00:00:00Z',
                entryStepSeq: 12,
                currentStepSeq: 12,
                targetName: 'Databricks',
                dealRole: 'md',
                conflictsApprovedBy: 'Avery Lindqvist',
                conflictsApprovedOn: '2026-07-14',
              },
            ],
          }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true) });

    // A code NOT in the seed set, so this only appears once the API resolves
    // (the loading fallback is the seed set, which has no PROJ-2026-999).
    await waitFor(() =>
      expect(result.current.deals.some((d) => d.code === 'PROJ-2026-999')).toBe(true),
    );
    // #162: user-scoped, so it bypasses Chromium's HTTP cache lock like /me.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/deals',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
    const created = result.current.deals.find((d) => d.code === 'PROJ-2026-999');
    expect(created?.id).toBe('PROJ-2026-999');
    expect(created?.target).toBe('Databricks');
    // Flag ON replaces the fixture set — the seed slug is gone.
    expect(result.current.deals.some((d) => d.id === 'project-summit')).toBe(false);
  });

  it('flag ON but the API fails: falls back to the fixture set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)),
    );

    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true) });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.deals.some((d) => d.id === 'project-summit')).toBe(true);
  });
});

describe('resolveActiveDeal with platform onboarding on', () => {
  it('never resolves a fixture slug from the URL, because that deal has no database row', () => {
    const resolved = resolveActiveDeal('project-summit', [], dealListSource(false, true));
    expect(resolved?.codename).toBe('project-summit');
    expect(resolved?.target).toBe('');
  });

  it('still resolves a fixture slug while the platform runs on fixtures', () => {
    const resolved = resolveActiveDeal('project-summit', [], dealListSource(false, false));
    expect(resolved?.codename).toBe('Project Summit');
  });
});

describe('useActiveDeal with platform onboarding on', () => {
  it('shows the segment as identity rather than a seed deal, with API create off', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useActiveDeal('project-summit'), {
      wrapper: flagsWrapper(false, true),
    });
    expect(result.current.codename).toBe('project-summit');
    expect(result.current.target).toBe('');
  });
});

describe('useDeals with platform onboarding on (QA-11)', () => {
  it('reads the API even when gate0_api_create is off, instead of the fixture slugs', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            deals: [
              {
                id: 'uuid-1',
                code: 'SUMMIT-2026-003',
                codename: 'Project Summit',
                status: 'active',
                createdAt: '2026-07-15T00:00:00Z',
                entryStepSeq: 12,
                currentStepSeq: 12,
                targetName: 'Databricks',
                dealRole: 'md',
                conflictsApprovedBy: null,
                conflictsApprovedOn: null,
              },
            ],
          }),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(false, true) });

    await waitFor(() =>
      expect(result.current.deals.some((d) => d.code === 'SUMMIT-2026-003')).toBe(true),
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(result.current.deals.some((d) => d.id === 'project-summit')).toBe(false);
  });

  it('never offers a fixture deal when the API fails: the fixtures have no database row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response),
      ),
    );

    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true, true) });

    // #162: a failed authoritative list is an explicit error, not an empty
    // "ready" list a consumer could read as "no deals".
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(result.current.state).toEqual({ status: 'error', reason: 'failed', deals: [] });
    expect(result.current.error).toBe(true);
    expect(result.current.deals).toHaveLength(0);
    expect(result.current.deals.some((d) => d.id === 'project-summit')).toBe(false);
  });
});

function apiDeal(code: string, codename: string) {
  return {
    id: `uuid-${code}`,
    code,
    codename,
    status: 'active',
    createdAt: '2026-07-15T00:00:00Z',
    entryStepSeq: 12,
    currentStepSeq: 12,
    targetName: null,
    dealRole: 'md',
    conflictsApprovedBy: null,
    conflictsApprovedOn: null,
  };
}

/** A /api/v1/deals mock whose responses the test resolves one by one. */
function deferredDealsFetch() {
  const pending: Array<(deals: ReturnType<typeof apiDeal>[]) => void> = [];
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        pending.push((deals) =>
          resolve({ ok: true, status: 200, json: () => Promise.resolve({ deals }) } as Response),
        );
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, pending };
}

function useThreeDeals() {
  return [useDeals(), useDeals(), useDeals()] as const;
}

describe('useDeals shares one in-flight read (#162)', () => {
  it('three mounted instances issue one GET /api/v1/deals', async () => {
    const { fetchMock, pending } = deferredDealsFetch();
    const { result } = renderHook(useThreeDeals, { wrapper: flagsWrapper(true) });

    await waitFor(() => expect(pending).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => pending[0]([apiDeal('MESAX-2026-462', 'Project Mesa')]));
    for (const instance of result.current) {
      expect(instance.state.status).toBe('ready');
      expect(instance.deals.map((d) => d.code)).toEqual(['MESAX-2026-462']);
    }
  });

  it('one DEALS_EVENT with three mounted instances issues exactly one new read, and no instance falls back', async () => {
    const { fetchMock, pending } = deferredDealsFetch();
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        const all = useThreeDeals();
        for (const instance of all) {
          if (instance.deals.some((d) => d.id === 'project-summit')) seen.push('fixture');
        }
        return all;
      },
      { wrapper: flagsWrapper(true) },
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]([apiDeal('MESAX-2026-462', 'Project Mesa')]));

    act(() => {
      window.dispatchEvent(new Event(DEALS_EVENT));
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () =>
      pending[1]([apiDeal('MESAX-2026-462', 'Project Mesa'), apiDeal('NEW-2026-001', 'Project New')]),
    );
    for (const instance of result.current) {
      expect(instance.state.status).toBe('ready');
      expect(instance.deals.map((d) => d.code)).toContain('NEW-2026-001');
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([]);
  });

  it.each([
    ['the fixture deal store', 'ib-fixture-deals', 1],
    ['a storage clear', null, 1],
    ['an unrelated key', 'ib-rail-collapsed', 0],
  ])('a storage event for %s issues %i new read(s)', async (_label, key, expected) => {
    const { fetchMock, pending } = deferredDealsFetch();
    renderHook(useThreeDeals, { wrapper: flagsWrapper(true) });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]([apiDeal('MESAX-2026-462', 'Project Mesa')]));

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key }));
    });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1 + expected);
  });

  it('reload() makes every instance re-join one fresh read', async () => {
    const { fetchMock, pending } = deferredDealsFetch();
    const { result } = renderHook(useThreeDeals, { wrapper: flagsWrapper(true) });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]([apiDeal('MESAX-2026-462', 'Project Mesa')]));

    act(() => result.current[0].reload());
    // Same identity: every instance keeps the list it has while the fresh read
    // runs (a reload after a write never blanks the page under it).
    for (const instance of result.current) {
      expect(instance.state.status).toBe('ready');
      expect(instance.deals.map((d) => d.codename)).toEqual(['Project Mesa']);
    }
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => pending[1]([apiDeal('MESAX-2026-462', 'Project Mesa II')]));
    for (const instance of result.current) {
      expect(instance.deals.map((d) => d.codename)).toEqual(['Project Mesa II']);
    }
  });

  it('an identity change still blanks a loaded list at once, even mid-reload', async () => {
    const { pending } = deferredDealsFetch();
    const { result } = renderHook(useThreeDeals, { wrapper: flagsWrapper(true) });
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]([apiDeal('MESAX-2026-462', 'Project Mesa')]));

    act(() => result.current[0].reload());
    act(() => abortAllReads());
    for (const instance of result.current) {
      expect(instance.state.status).toBe('loading');
      expect(instance.deals).toEqual([]);
    }
  });

  it('flag OFF: a fixture write (createDeal) updates a mounted instance without a fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    clearStoredDeals();
    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(false) });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));

    let created = '';
    act(() => {
      created = createDeal({ id: 'canva', name: 'Canva', sector: 'Visual design platform' }, 'Project Harbour')
        .id;
    });
    await waitFor(() => expect(result.current.deals.some((d) => d.id === created)).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useDeals error state and deadline (#162 Phase 3)', () => {
  /** A /deals that never answers and, like a stuck request, ignores its signal. */
  function hangingFetch() {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function pastTheDeadline() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RAIL_LOAD_DEADLINE_MS);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('platform onboarding: a read past the deadline is error("timeout") with no fixtures', async () => {
    vi.useFakeTimers();
    hangingFetch();
    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true, true) });
    await act(async () => {});
    expect(result.current.state.status).toBe('loading');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RAIL_LOAD_DEADLINE_MS - 1);
    });
    expect(result.current.state.status).toBe('loading');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current.state).toEqual({ status: 'error', reason: 'timeout', deals: [] });
    expect(result.current.error).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.deals.some((d) => d.id === 'project-summit')).toBe(false);
  });

  it('API create only (G1 P0): a timeout is still an error, never a silent fixture "ready"', async () => {
    vi.useFakeTimers();
    hangingFetch();
    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true) });
    await act(async () => {});
    await pastTheDeadline();

    expect(result.current.state.status).toBe('error');
    expect(result.current.state).toMatchObject({ status: 'error', reason: 'timeout' });
    expect(result.current.error).toBe(true);
  });

  it('G1 P0: a failure that is not a timeout keeps the permitted fixture fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)),
    );
    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true) });

    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.error).toBe(false);
    expect(result.current.deals.some((d) => d.id === 'project-summit')).toBe(true);
  });

  it('reload() from the error presents loading synchronously: no error frame during the refetch', async () => {
    let fail = true;
    const fetchMock = vi.fn(() =>
      fail
        ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)
        : new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useDeals(), { wrapper: flagsWrapper(true, true) });
    await waitFor(() => expect(result.current.state.status).toBe('error'));

    fail = false;
    act(() => result.current.reload());
    // Same act, no await: the stale error is already gone.
    expect(result.current.state.status).toBe('loading');
    expect(result.current.error).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe('useActiveDealState (#162 Phase 3)', () => {
  it('reports unavailable with a retry when the list failed, keeping the placeholder as the deal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)),
    );
    const { result } = renderHook(() => useActiveDealState('MESAX-2026-462'), {
      wrapper: flagsWrapper(true, true),
    });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.deal).toEqual(pendingDealForCode('MESAX-2026-462'));
    expect(typeof result.current.retry).toBe('function');
  });
});
