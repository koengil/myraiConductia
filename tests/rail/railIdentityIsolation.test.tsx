import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as React from 'react';


/*
 * #162 audit: rail state kept outside the generation-stamped reads never
 * crosses an identity. A completes or skips a step locally and has a run
 * receipt on a step; the identity changes in the same document
 * (SIGNED_OUT, then SIGNED_IN as B); B's rail shows none of it.
 *
 * The persisted stores are stamped with their owner, so the same holds in a
 * fresh document whose FIRST auth event is already B (A's session ended
 * without an in-page sign-out: expiry, cleared cookies, a closed tab).
 *
 * Flag-off rail (catalogue fixture, seeded sandbox deal): the rail itself is
 * ready synchronously, so only the identity key and the store clear can hide
 * A's state.
 */

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;

const auth = vi.hoisted(() => ({ callback: null as AuthCallback | null }));

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { email: 'md@bank.test' } } }),
      onAuthStateChange: (cb: AuthCallback) => {
        auth.callback = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: async () => ({ error: null }),
    },
  }),
}));

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ projectId: 'project-summit' }),
  usePathname: () => '/projects/project-summit/rail',
  useSearchParams: () => new URLSearchParams(search),
}));

const TEASER_LIVE = 'Step 32 · Teaser · Current step';
const TEASER_SKIPPED = 'Step 32 · Teaser · Skipped';
const NEXT_LIVE = /^Step 33 · .+ · Current step$/;

const RUN_KEY = 'ib-rail-run:project-summit';
const GATE0_KEY = 'ib-gate0-receipt:SUM-2026-014';

/** Unfold every "N done" row. The seeded rail always has one (a missing row
 *  throws here), so "no receipt" below reads the cards, not a closed fold. */
function unfoldDone() {
  for (const fold of screen.getAllByRole('button', { name: /^\d+ done$/ })) {
    if (fold.getAttribute('aria-expanded') !== 'true') fireEvent.click(fold);
  }
}

/** A's run receipt on the first Preparation step, a done card under the fold.
 *  `uid: undefined` writes an unstamped legacy entry. */
function seedReceiptForA(uid: string | undefined = 'a') {
  window.localStorage.setItem(
    RUN_KEY,
    JSON.stringify({
      uid,
      receipts: {
        'p2-s26': [
          {
            id: 'r-a',
            label: 'Screened',
            verdict: 'clear',
            checks: ['KYC ✓', 'FINRA ✓', 'MNPI ✓'],
            seconds: 12,
            at: '2026-07-07T10:00:00.000Z',
          },
        ],
      },
      versions: {},
    }),
  );
}

/** A's Gate 0 create receipt for the sandbox deal, as the wizard stashes it. */
function seedGate0ReceiptForA(uid: string | undefined = 'a') {
  window.sessionStorage.setItem(
    GATE0_KEY,
    JSON.stringify({ verdict: 'compliant', recipients: 1, at: '2026-07-16T10:00:00Z', uid }),
  );
}

/** A fresh document (modules reset in beforeEach) whose first auth event is `userId`'s. */
async function mountRailAs(userId: string) {
  const { DealRail } = await import('@/components/rail/DealRail');
  const { SessionProvider } = await import('@/lib/session/store');
  render(
    <SessionProvider>
      <DealRail />
    </SessionProvider>,
  );
  await waitFor(() => expect(auth.callback).not.toBeNull());
  act(() => auth.callback!('INITIAL_SESSION', { user: { id: userId } }));
  await screen.findByRole('button', { name: TEASER_LIVE });
}

async function mountRailAsA() {
  await mountRailAs('a');
}

async function skipTeaserAsA() {
  fireEvent.click(screen.getByRole('button', { name: TEASER_LIVE }));
  const focus = await screen.findByLabelText('Step detail');
  fireEvent.click(within(focus).getByRole('button', { name: 'Skip…' }));
  const modal = await screen.findByRole('dialog', { name: 'Skip Teaser' });
  fireEvent.change(within(modal).getByRole('textbox'), {
    target: { value: 'Client supplied their own teaser.' },
  });
  fireEvent.click(within(modal).getByRole('button', { name: 'Skip step' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Zoom out to Preparation' }));
  expect(await screen.findByRole('button', { name: TEASER_SKIPPED })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: NEXT_LIVE })).toBeInTheDocument();
}

beforeEach(() => {
  vi.resetModules();
  auth.callback = null;
  search = '';
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// Each case is a fresh document: vi.resetModules() and a re-import of the
// whole rail graph, then the full 61-station rail. That is several times the
// work of the census renders the 15s default was sized for (vitest.config.ts),
// so on a loaded runner these mounting cases get a larger budget.
const FRESH_RAIL_TIMEOUT = 45_000;

describe('rail state never crosses an identity (#162)', { timeout: FRESH_RAIL_TIMEOUT }, () => {
  it("A's local skip and completion overrides and run receipts are gone from B's rail after SIGNED_OUT then SIGNED_IN as B", async () => {
    seedReceiptForA();
    await mountRailAsA();
    unfoldDone();
    expect(screen.getByRole('button', { name: /Screened · 12s/ })).toBeInTheDocument();
    await skipTeaserAsA();

    act(() => auth.callback!('SIGNED_OUT', null));
    act(() => auth.callback!('SIGNED_IN', { user: { id: 'b' } }));

    // B's rail: the catalogue cursor, no skip, no advanced cursor, no receipt.
    expect(await screen.findByRole('button', { name: TEASER_LIVE })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TEASER_SKIPPED })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: NEXT_LIVE })).not.toBeInTheDocument();
    unfoldDone();
    expect(screen.queryByRole('button', { name: /Screened · 12s/ })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('ib-rail-run:project-summit')).toBeNull();
  });

  it('a direct account switch (SIGNED_IN as B, no SIGNED_OUT) drops A\'s overrides too', async () => {
    await mountRailAsA();
    await skipTeaserAsA();

    act(() => auth.callback!('SIGNED_IN', { user: { id: 'b' } }));

    expect(await screen.findByRole('button', { name: TEASER_LIVE })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: TEASER_SKIPPED })).not.toBeInTheDocument();
  });

  it('a same-user re-emit keeps the overrides: nothing changed hands', async () => {
    await mountRailAsA();
    await skipTeaserAsA();

    act(() => auth.callback!('SIGNED_IN', { user: { id: 'a' } }));
    act(() => auth.callback!('TOKEN_REFRESHED', { user: { id: 'a' } }));

    expect(screen.getByRole('button', { name: TEASER_SKIPPED })).toBeInTheDocument();
  });
});

describe('a fresh document whose first auth event is already another user (#162)', { timeout: FRESH_RAIL_TIMEOUT }, () => {
  it.each([
    ["A's stamped entries", 'a'],
    ['unstamped legacy entries', undefined],
  ])("B's INITIAL_SESSION first: B's rail and Gate 0 receipt show nothing of %s, and they are dropped", async (_label, uid) => {
    seedReceiptForA(uid);
    seedGate0ReceiptForA(uid);
    search = 'new=1';

    await mountRailAs('b');

    // The banner's one-shot take ran as B: the receipt is gone, never shown.
    await waitFor(() => expect(window.sessionStorage.getItem(GATE0_KEY)).toBeNull());
    await act(async () => {});
    expect(screen.queryByRole('status', { name: 'Mandate opened' })).not.toBeInTheDocument();
    unfoldDone();
    expect(screen.queryByRole('button', { name: /Screened · 12s/ })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(RUN_KEY)).toBeNull();
  });

  it("A's own INITIAL_SESSION first: A still sees A's run receipt and Gate 0 receipt", async () => {
    seedReceiptForA();
    seedGate0ReceiptForA();
    search = 'new=1';

    await mountRailAs('a');
    unfoldDone();

    expect(await screen.findByRole('button', { name: /Screened · 12s/ })).toBeInTheDocument();
    const banner = await screen.findByRole('status', { name: 'Mandate opened' });
    expect(banner).toHaveTextContent(/Compliant/);
    expect(window.localStorage.getItem(RUN_KEY)).not.toBeNull();
  });

  it('before the first auth event nothing persisted is shown, and the Gate 0 receipt waits for its owner', async () => {
    seedReceiptForA();
    seedGate0ReceiptForA();
    search = 'new=1';
    const { DealRail } = await import('@/components/rail/DealRail');
    const { SessionProvider } = await import('@/lib/session/store');
    render(
      <SessionProvider>
        <DealRail />
      </SessionProvider>,
    );
    await screen.findByRole('button', { name: TEASER_LIVE });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    unfoldDone();

    expect(screen.queryByRole('button', { name: /Screened · 12s/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Mandate opened' })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(GATE0_KEY)).not.toBeNull();

    act(() => auth.callback!('INITIAL_SESSION', { user: { id: 'a' } }));

    expect(await screen.findByRole('button', { name: /Screened · 12s/ })).toBeInTheDocument();
    expect(await screen.findByRole('status', { name: 'Mandate opened' })).toBeInTheDocument();
  });
});

describe('railRunState owner stamping (#162)', () => {
  const RECEIPT = { label: 'Screened', verdict: 'clear' as const, checks: ['KYC ✓'], seconds: 12 };

  it("stamps a write with its owner and never returns another owner's entry", async () => {
    const { setStoreOwner } = await import('@/lib/session/storeOwner');
    const { addReceipt, getRunState } = await import('@/components/rail/railRunState');

    setStoreOwner('a');
    addReceipt('MESAX-2026-462', 'p2-s36', RECEIPT);
    expect(JSON.parse(window.localStorage.getItem('ib-rail-run:MESAX-2026-462')!).uid).toBe('a');
    expect(getRunState('MESAX-2026-462').receipts['p2-s36']).toHaveLength(1);

    setStoreOwner('b');
    expect(getRunState('MESAX-2026-462').receipts).toEqual({});
    expect(window.localStorage.getItem('ib-rail-run:MESAX-2026-462')).toBeNull();
  });

  it('with no known owner a read returns nothing and a write persists nothing', async () => {
    const { setStoreOwner } = await import('@/lib/session/storeOwner');
    const { addReceipt, appendVersion, getRunState } = await import('@/components/rail/railRunState');

    setStoreOwner('a');
    addReceipt('MESAX-2026-462', 'p2-s36', RECEIPT);
    setStoreOwner(null);
    expect(getRunState('MESAX-2026-462').receipts).toEqual({});
    // The owner's entry is left for when the owner is known again.
    expect(window.localStorage.getItem('ib-rail-run:MESAX-2026-462')).not.toBeNull();

    addReceipt('HAR-2026-021', 'p2-s36', RECEIPT);
    appendVersion('HAR-2026-021', 'p2-s36', 'Teaser V1');
    expect(window.localStorage.getItem('ib-rail-run:HAR-2026-021')).toBeNull();
  });
});
