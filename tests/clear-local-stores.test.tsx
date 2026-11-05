import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ProfileMenu } from '@/components/profile/ProfileMenu';
import { clearLocalStores, clearRailStores } from '@/lib/session/clearLocalStores';
import { addReceipt, appendVersion, getRunState } from '@/components/rail/railRunState';
import { stashGate0Receipt } from '@/lib/deals/gate0Receipt';
import { setStoreOwner } from '@/lib/session/storeOwner';
import { logAudit, readAudit } from '@/lib/audit/store';
import { listDrafts, newDraftId, saveDraft } from '@/lib/mail/drafts';

const { replaceMock, refreshMock, signOutMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  refreshMock: vi.fn(),
  signOutMock: vi.fn(async () => ({ error: null })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock, refresh: refreshMock }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({ auth: { signOut: signOutMock } }),
}));

const DEALS_KEY = 'ib-fixture-deals';
const TOKENS_KEY = 'ib-deal-tokens';
const AUDIT_KEY = 'ib-audit-log';

function draft(id: string) {
  return {
    id,
    to: 'buyer@acquirer.example',
    cc: '',
    bcc: '',
    subject: 'Indicative terms',
    bodyHtml: '<p>Numbers that never passed compliance.</p>',
    updatedAt: new Date().toISOString(),
  };
}

function seedEveryStore() {
  logAudit('chat', 'Typed', 'Draft the IOI response', { deal: 'Project Summit' });
  saveDraft(draft(newDraftId()), 'project-summit');
  saveDraft(draft(newDraftId()));
  window.localStorage.setItem(DEALS_KEY, JSON.stringify([{ id: 'project-summit' }]));
  window.localStorage.setItem(TOKENS_KEY, JSON.stringify({ 'project-summit': 4200 }));
}

beforeEach(() => {
  window.localStorage.clear();
  replaceMock.mockClear();
  refreshMock.mockClear();
  signOutMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('clearLocalStores', () => {
  it('clears every browser-local store the previous banker left behind', () => {
    seedEveryStore();
    expect(readAudit()).toHaveLength(1);
    expect(listDrafts('project-summit')).toHaveLength(1);
    expect(listDrafts()).toHaveLength(1);

    clearLocalStores();

    expect(readAudit()).toEqual([]);
    expect(listDrafts('project-summit')).toEqual([]);
    expect(listDrafts()).toEqual([]);
    expect(window.localStorage.getItem(DEALS_KEY)).toBeNull();
    expect(window.localStorage.getItem(TOKENS_KEY)).toBeNull();
  });

  it('sweeps drafts under every project scope, not just the active one', () => {
    saveDraft(draft(newDraftId()), 'project-summit');
    saveDraft(draft(newDraftId()), 'project-harbor');

    clearLocalStores();

    expect(listDrafts('project-summit')).toEqual([]);
    expect(listDrafts('project-harbor')).toEqual([]);
  });

  it('keeps clearing the remaining stores when one store throws', () => {
    seedEveryStore();
    const real = window.localStorage;
    vi.stubGlobal('localStorage', {
      ...real,
      get length(): number {
        throw new Error('storage disabled');
      },
      key: real.key.bind(real),
      getItem: real.getItem.bind(real),
      setItem: real.setItem.bind(real),
      removeItem: real.removeItem.bind(real),
      clear: real.clear.bind(real),
    });

    expect(() => clearLocalStores()).not.toThrow();

    expect(real.getItem(DEALS_KEY)).toBeNull();
    expect(real.getItem(TOKENS_KEY)).toBeNull();
    expect(JSON.parse(real.getItem(AUDIT_KEY) ?? '[]')).toEqual([]);
  });
});

describe('rail stores (#162)', () => {
  /** Every persisted rail store: keyed by deal code, stamped with its owner. */
  const RAIL_KEYS = {
    local: ['ib-rail-run:project-summit', 'ib-rail-run:MESAX-2026-462'],
    session: ['ib-gate0-receipt:MESAX-2026-462', 'ib-gate0-receipt:SUM-2026-014'],
  };

  function seedRailStores() {
    addReceipt('project-summit', 'p2-s36', {
      label: 'Screened',
      verdict: 'clear',
      checks: ['KYC ✓'],
      seconds: 12,
    });
    appendVersion('MESAX-2026-462', 'p2-s36', 'Teaser V1');
    stashGate0Receipt('MESAX-2026-462', { verdict: 'compliant', recipients: 1, at: null });
    stashGate0Receipt('SUM-2026-014', { verdict: 'hold', recipients: 0, at: null });
    for (const k of RAIL_KEYS.local) expect(window.localStorage.getItem(k)).not.toBeNull();
    for (const k of RAIL_KEYS.session) expect(window.sessionStorage.getItem(k)).not.toBeNull();
  }

  beforeEach(() => {
    window.sessionStorage.clear();
    setStoreOwner('user-a');
  });
  afterEach(() => {
    window.sessionStorage.clear();
    setStoreOwner(null);
  });

  it('clearLocalStores removes every persisted rail store key, for every deal', () => {
    seedRailStores();
    window.localStorage.setItem('ib-rail-collapsed', '1');

    clearLocalStores();

    for (const k of RAIL_KEYS.local) expect(window.localStorage.getItem(k)).toBeNull();
    for (const k of RAIL_KEYS.session) expect(window.sessionStorage.getItem(k)).toBeNull();
    expect(getRunState('project-summit').receipts).toEqual({});
    // The shell's collapse preference is not deal state.
    expect(window.localStorage.getItem('ib-rail-collapsed')).toBe('1');
  });

  it('clearRailStores removes the same keys and leaves the other stores alone', () => {
    seedEveryStore();
    seedRailStores();

    clearRailStores();

    for (const k of RAIL_KEYS.local) expect(window.localStorage.getItem(k)).toBeNull();
    for (const k of RAIL_KEYS.session) expect(window.sessionStorage.getItem(k)).toBeNull();
    expect(readAudit()).toHaveLength(1);
    expect(window.localStorage.getItem(DEALS_KEY)).not.toBeNull();
  });
});

describe('ProfileMenu sign-out', () => {
  function openMenu() {
    render(<ProfileMenu name="Storm Duncan" roleLabel="Managing Director" initials="SD" />);
    fireEvent.click(screen.getByRole('button', { name: /open profile menu/i }));
  }

  it('clears the local stores before routing to sign-in', async () => {
    seedEveryStore();
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/sign-in'));
    expect(readAudit()).toEqual([]);
    expect(listDrafts('project-summit')).toEqual([]);
    expect(window.localStorage.getItem(DEALS_KEY)).toBeNull();
    expect(window.localStorage.getItem(TOKENS_KEY)).toBeNull();
  });

  it('still signs out when localStorage is unavailable', async () => {
    const boom = () => {
      throw new Error('storage disabled');
    };
    vi.stubGlobal('localStorage', {
      get length(): number {
        return boom();
      },
      key: boom,
      getItem: boom,
      setItem: boom,
      removeItem: boom,
      clear: boom,
    });
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/sign-in'));
    expect(signOutMock).toHaveBeenCalled();
    expect(screen.queryByText('Could not sign out. Try again.')).toBeNull();
  });
});
