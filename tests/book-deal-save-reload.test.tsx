import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { BookDeal } from '@/components/book/BookDeal';
import { abortAllReads } from '@/lib/api/inflightRead';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';

/*
 * #162 regression (the hermetic Book journey): a Book field save reloads the
 * deal list. With the real useDeals, that reload must keep the deal on screen
 * while the fresh list is read, so the editor is not unmounted and the
 * "Saved." receipt the MD just earned survives the refreshed list.
 */

const CODE = 'MESAX-2026-462';
const DEALS_URL = '/api/v1/deals';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ projectId: CODE }),
  usePathname: () => `/projects/${CODE}/book`,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }) },
  }),
}));

function flags(): FlagMap {
  const map = Object.fromEntries(
    (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, false]),
  ) as FlagMap;
  return { ...map, gate0_api_create: true, platform_onboarding: true };
}

function apiDeal(targetCloseDate: string | null) {
  return {
    id: 'uuid-mesa',
    code: CODE,
    codename: 'Project Mesa',
    status: 'active',
    createdAt: '2026-07-15T00:00:00Z',
    entryStepSeq: 1,
    currentStepSeq: 1,
    targetName: null,
    dealRole: 'md',
    conflictsApprovedBy: null,
    conflictsApprovedOn: null,
    targetCloseDate,
  };
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

let pendingLists: Array<(targetCloseDate: string | null) => void>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pendingLists = [];
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === DEALS_URL) {
      return new Promise<Response>((resolve) => {
        pendingLists.push((date) => resolve(json({ deals: [apiDeal(date)] })));
      });
    }
    if (url === `/api/v1/deals/${CODE}` && init?.method === 'PATCH') {
      return Promise.resolve(json({ deal: { code: CODE, targetCloseDate: '2026-11-20' } }));
    }
    return Promise.resolve(json({ error: 'Not found' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  abortAllReads();
  vi.unstubAllGlobals();
});

describe('BookDeal save with the real deal list (#162)', () => {
  it('keeps the editor and its "Saved." receipt through the reload that follows a save', async () => {
    render(
      <FlagsProvider value={flags()}>
        <BookDeal />
      </FlagsProvider>,
    );
    await waitFor(() => expect(pendingLists).toHaveLength(1));
    await act(async () => pendingLists[0](null));

    fireEvent.change(await screen.findByLabelText('Target close date'), {
      target: { value: '2026-11-20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save target close' }));
    await screen.findByText('Saved.');

    // The save reloaded the list: one fresh read is in flight, and the page
    // under it never went back to "Loading the deal…".
    await waitFor(() => expect(pendingLists).toHaveLength(2));
    expect(screen.queryByText('Loading the deal…')).not.toBeInTheDocument();
    expect(screen.getByText('Saved.')).toBeInTheDocument();

    await act(async () => pendingLists[1]('2026-11-20'));
    expect(screen.getByText('Saved.')).toBeInTheDocument();
    expect(screen.getByText(/^Target close:/).textContent).toContain('Nov 20, 2026');
    expect(screen.getByRole('button', { name: 'Save target close' })).toBeDisabled();
  });
});
