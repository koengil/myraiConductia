import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getLeadCatalogState,
  invalidateLeadCatalog,
  prefetchLeadCatalog,
  subscribeLeadCatalog,
} from '@/lib/leads/leadCatalog';

afterEach(() => {
  invalidateLeadCatalog();
  vi.unstubAllGlobals();
});

function okResponse(companies: Array<{ id: string; name: string }>) {
  return { ok: true, json: async () => ({ companies }) };
}

describe('prefetchLeadCatalog', () => {
  it('serves the warm cache without waiting, and revalidates behind it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([{ id: 'c1', name: 'Canva' }]))
      .mockResolvedValue(okResponse([
        { id: 'c1', name: 'Canva' },
        { id: 'c2', name: 'Reddit' },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const first = await prefetchLeadCatalog();
    expect(first.status).toBe('ready');
    if (first.status === 'ready') {
      expect(first.leads).toEqual([{ id: 'c1', name: 'Canva', sector: '' }]);
    }

    const second = await prefetchLeadCatalog();
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.waitFor(() => {
      const state = getLeadCatalogState();
      expect(state.status === 'ready' && state.leads).toHaveLength(2);
    });
  });

  it('never publishes idle or loading while a warm cache is revalidating', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([{ id: 'c1', name: 'Canva' }])));
    await prefetchLeadCatalog();

    const seen: string[] = [];
    const unsubscribe = subscribeLeadCatalog(() => seen.push(getLeadCatalogState().status));

    await prefetchLeadCatalog();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    unsubscribe();

    expect(seen).not.toContain('idle');
    expect(seen).not.toContain('loading');
  });

  it('keeps the warm list when a revalidation fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse([{ id: 'c1', name: 'Canva' }]))
      .mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await prefetchLeadCatalog();
    await prefetchLeadCatalog();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const state = getLeadCatalogState();
    expect(state.status).toBe('ready');
    if (state.status === 'ready') {
      expect(state.leads).toEqual([{ id: 'c1', name: 'Canva', sector: '' }]);
    }
  });

  it('records error state when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const state = await prefetchLeadCatalog();

    expect(state.status).toBe('error');
    expect(getLeadCatalogState().status).toBe('error');
  });
});
