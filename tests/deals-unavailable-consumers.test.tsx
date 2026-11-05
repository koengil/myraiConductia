import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { AuditTrail } from '@/components/audit/AuditTrail';
import { BookDeal } from '@/components/book/BookDeal';
import { BookHome } from '@/components/book/BookHome';
import { DataRoom } from '@/components/dataroom/DataRoom';
import { TopNavDealSwitcher } from '@/components/organisms/navigation/TopNavDealSwitcher';
import { Sidebar } from '@/components/organisms/navigation/Sidebar';
import { DealContextBar } from '@/components/shell/DealContextBar';
import { CommandCenter } from '@/components/workspace/CommandCenter';
import { abortAllReads } from '@/lib/api/inflightRead';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { SessionProvider } from '@/lib/session/store';

/*
 * #162 Phase 3: every consumer that states a fact from the deal list renders
 * an unavailable state with Try again when the list failed (platform
 * onboarding on). Never "No deal here yet", an empty book, a placeholder's
 * facts or a seed fixture. Try again re-joins one fresh GET /api/v1/deals.
 */

const DEAL = 'MESAX-2026-462';
const DEALS_URL = '/api/v1/deals';
const STATEMENT = 'Your deal list could not be loaded right now.';
const SHORT = 'Deals unavailable.';

let pathname = `/projects/${DEAL}/rail`;
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: DEAL }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { email: 'book-md@bank.test' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  }),
}));

vi.mock('@/lib/audit/serverAudit', () => ({ fetchServerAudit: vi.fn(async () => null) }));
vi.mock('@/components/wizard/NewMandateDialog', () => ({ NewMandateDialog: () => null }));

const ME = {
  user: {
    id: 'user-1',
    email: 'book-md@bank.test',
    full_name: 'Storm Duncan',
    display_name: 'Storm Duncan',
    firm_role: null,
    department: null,
    is_external: false,
    status: 'active',
    company_id: null,
    company_role: null,
    can_invite: false,
  },
  company: null,
  mandate: null,
};

function flags(): FlagMap {
  const map = Object.fromEntries(
    (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, false]),
  ) as FlagMap;
  return { ...map, gate0_api_create: true, platform_onboarding: true };
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pathname = `/projects/${DEAL}/rail`;
  window.localStorage.clear();
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === DEALS_URL) return json({ error: 'Unavailable' }, 503);
    if (url.startsWith('/api/v1/me')) return json(ME);
    if (url.startsWith('/api/v1/notifications')) return json({ notifications: [] });
    if (url.startsWith('/api/v1/access-requests')) return json({ requests: [] });
    return json({ error: 'Not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  abortAllReads();
  vi.unstubAllGlobals();
});

function dealsCalls(): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === DEALS_URL).length;
}

function renderWithFlags(node: React.ReactNode) {
  return render(
    <FlagsProvider value={flags()}>
      <SessionProvider>{node}</SessionProvider>
    </FlagsProvider>,
  );
}

/** Try again re-joins exactly one fresh read, and the statement leaves at once. */
async function retryOnce(button: HTMLElement, statement: string) {
  await waitFor(() => expect(dealsCalls()).toBe(1));
  act(() => button.click());
  expect(screen.queryByText(statement)).not.toBeInTheDocument();
  await waitFor(() => expect(dealsCalls()).toBe(2));
  // The second read fails too: the statement returns, and nothing else ran.
  expect(await screen.findByText(statement)).toBeInTheDocument();
  expect(dealsCalls()).toBe(2);
}

describe('deal-list consumers when GET /api/v1/deals fails (#162)', () => {
  it('Sidebar: the Deals slot says so, with Try again', async () => {
    renderWithFlags(<Sidebar collapsed={false} onToggle={() => {}} />);
    expect(await screen.findByText(SHORT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select a deal|Switch deal/ })).toBeNull();
    await retryOnce(screen.getByRole('button', { name: /Try again/ }), SHORT);
  });

  it('TopNavDealSwitcher: the menu says so, with Try again', async () => {
    renderWithFlags(<TopNavDealSwitcher projectId={DEAL} showNewDeal={false} />);
    await waitFor(() => expect(dealsCalls()).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: /Switch deal|Select a deal/ }));
    expect(await screen.findByText(SHORT)).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Deals' })).toBeNull();
    await retryOnce(screen.getByRole('button', { name: /Try again/ }), SHORT);
  });

  it('DealContextBar: the identity slot says so and makes no phase claim', async () => {
    renderWithFlags(<DealContextBar />);
    expect(await screen.findByText(SHORT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch deal/ })).toBeNull();
    expect(screen.queryByText(/Phase/)).toBeNull();
    await retryOnce(screen.getByRole('button', { name: /Try again/ }), SHORT);
  });

  it('CommandCenter: the statement comes before any count or "No live deals yet."', async () => {
    pathname = '/projects';
    renderWithFlags(<CommandCenter />);
    expect(await screen.findByText(STATEMENT)).toBeInTheDocument();
    expect(screen.queryByText('No live deals yet.')).toBeNull();
    expect(screen.queryByText(/across 0 live deals/)).toBeNull();
    await retryOnce(screen.getByRole('button', { name: 'Try again' }), STATEMENT);
  });

  it('BookHome: the statement, not an empty book', async () => {
    pathname = '/projects';
    renderWithFlags(<BookHome />);
    expect(await screen.findByText(STATEMENT)).toBeInTheDocument();
    expect(screen.queryByText('No live deals yet.')).toBeNull();
    await retryOnce(screen.getByRole('button', { name: 'Try again' }), STATEMENT);
  });

  it('BookDeal: the statement, never "No deal here yet." and never the placeholder deal', async () => {
    pathname = `/projects/${DEAL}/book`;
    renderWithFlags(<BookDeal />);
    expect(await screen.findByText(STATEMENT)).toBeInTheDocument();
    expect(screen.queryByText(/No deal here yet/)).toBeNull();
    expect(screen.queryByRole('heading', { name: new RegExp(DEAL) })).toBeNull();
    await retryOnce(screen.getByRole('button', { name: 'Try again' }), STATEMENT);
  });

  it('AuditTrail: the register says so instead of a short or empty record', async () => {
    pathname = `/projects/${DEAL}/audit`;
    renderWithFlags(<AuditTrail />);
    expect(await screen.findByText(STATEMENT)).toBeInTheDocument();
    expect(screen.queryByText(/No activity yet/)).toBeNull();
    expect(screen.queryByTestId('audit-event-count')).toBeNull();
    await retryOnce(screen.getByRole('button', { name: 'Try again' }), STATEMENT);
  });

  it('DataRoom: the header says so, with Try again', async () => {
    pathname = `/projects/${DEAL}/data-room`;
    renderWithFlags(<DataRoom kind="data-room" />);
    expect(await screen.findByText(STATEMENT)).toBeInTheDocument();
    await retryOnce(screen.getByRole('button', { name: 'Try again' }), STATEMENT);
  });
});
