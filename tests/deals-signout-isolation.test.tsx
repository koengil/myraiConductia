import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import type { FlagMap } from '@/lib/flags/resolveFlags';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';

/*
 * #162: the deal list and rail are shared in-flight reads. Sharing must never
 * cross an identity: a read started as one user is never delivered after a
 * sign-out or identity change, and a list already loaded for that user stops
 * rendering the moment the identity changes.
 */

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;

const auth = vi.hoisted(() => ({
  callback: null as AuthCallback | null,
  signOut: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { email: 'md@bank.test' } } }),
      onAuthStateChange: (cb: AuthCallback) => {
        auth.callback = cb;
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
      signOut: auth.signOut,
    },
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({ projectId: 'MESAX-2026-462' }),
  usePathname: () => '/projects/MESAX-2026-462/rail',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/wizard/NewMandateDialog', () => ({ NewMandateDialog: () => null }));

const RAIL_URL = '/api/v1/deals/MESAX-2026-462/rail';

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

const LISTS: Record<string, ReturnType<typeof apiDeal>[]> = {
  a: [apiDeal('MESAX-2026-462', 'Project Alpha Only')],
  b: [apiDeal('BRAVO-2026-001', 'Project Bravo Only')],
};

function flags(): FlagMap {
  const map = Object.fromEntries(
    (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, false]),
  ) as FlagMap;
  return { ...map, gate0_api_create: true, platform_onboarding: true, project_rail_model: true };
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/** The server answers as whoever holds the session when the request is made. */
let sessionUser: string | null;
let holdDeals: boolean;
let heldDeals: Array<() => void>;
let fetchMock: ReturnType<typeof vi.fn>;

function dealsCalls(): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/v1/deals').length;
}
function railCalls(): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === RAIL_URL).length;
}

beforeEach(() => {
  vi.resetModules();
  auth.callback = null;
  auth.signOut = vi.fn(async () => ({ error: null }));
  sessionUser = 'a';
  holdDeals = false;
  heldDeals = [];
  window.localStorage.clear();
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const asUser = sessionUser;
    if (url === '/api/v1/deals') {
      const respond = () =>
        asUser ? json({ deals: LISTS[asUser] }) : json({ error: 'Unauthorized' }, 401);
      if (!holdDeals) return Promise.resolve(respond());
      return new Promise<Response>((resolve) => heldDeals.push(() => resolve(respond())));
    }
    if (url === RAIL_URL) {
      return Promise.resolve(
        json({ currentStepId: null, canEditStructure: false, canSaveTemplate: false, phases: [], steps: [] }),
      );
    }
    if (url.startsWith('/api/v1/me')) {
      return Promise.resolve(
        json({
          user: {
            id: `user-${asUser}`,
            email: 'md@bank.test',
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
        }),
      );
    }
    return Promise.resolve(json({ error: 'Not found' }, 404));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  cleanup();
  const { abortAllReads } = await import('@/lib/api/inflightRead');
  abortAllReads();
  vi.unstubAllGlobals();
});

/** Every codename any render ever handed a consumer. */
let rendered: string[];

async function mountProbe(withRail = false) {
  const { FlagsProvider } = await import('@/lib/flags/FlagsContext');
  const { useDeals } = await import('@/lib/deals/useDeals');
  const { useProjectRail } = await import('@/lib/rail/projectRail');
  rendered = [];

  function RailProbe() {
    const { status } = useProjectRail('MESAX-2026-462');
    return <p data-testid="rail">{status}</p>;
  }
  function DealsProbe() {
    const { state, deals } = useDeals();
    for (const d of deals) rendered.push(d.codename);
    return (
      <div>
        <p data-testid="status">{state.status}</p>
        <ul>
          {deals.map((d) => (
            <li key={d.id}>{d.codename}</li>
          ))}
        </ul>
      </div>
    );
  }

  render(
    <FlagsProvider value={flags()}>
      <DealsProbe />
      <DealsProbe />
      {withRail ? <RailProbe /> : null}
    </FlagsProvider>,
  );
  await waitFor(() => expect(auth.callback).not.toBeNull());
  act(() => auth.callback!('INITIAL_SESSION', { user: { id: 'a' } }));
}

describe('deal reads never cross an identity (#162)', () => {
  it('(a) a read started as A that resolves after SIGNED_OUT is never rendered', async () => {
    holdDeals = true;
    await mountProbe();
    await waitFor(() => expect(heldDeals).toHaveLength(1));

    // The auth listener alone (no explicit abortAllReads call) drops A's read.
    sessionUser = null;
    act(() => auth.callback!('SIGNED_OUT', null));
    await waitFor(() => expect(heldDeals).toHaveLength(2));

    await act(async () => heldDeals[0]()); // A's response lands late
    await act(async () => heldDeals[1]()); // the signed-out re-read: 401
    // Under platform_onboarding a failed list is an explicit error (Phase 3),
    // never A's list and never an empty "ready" one.
    await waitFor(() => expect(screen.getAllByTestId('status')[0]).toHaveTextContent('error'));

    expect(rendered).not.toContain('Project Alpha Only');
    expect(screen.queryByText('Project Alpha Only')).not.toBeInTheDocument();
  });

  it('(b) A\'s loaded list disappears synchronously on SIGNED_OUT; B\'s list comes from one fresh read', async () => {
    await mountProbe();
    expect(await screen.findAllByText('Project Alpha Only')).toHaveLength(2);

    sessionUser = null;
    holdDeals = true;
    act(() => auth.callback!('SIGNED_OUT', null));
    // Same act, no await: the stale list is already gone.
    expect(screen.queryByText('Project Alpha Only')).not.toBeInTheDocument();
    for (const s of screen.getAllByTestId('status')) expect(s).toHaveTextContent('loading');
    rendered = [];

    await waitFor(() => expect(heldDeals).toHaveLength(1));
    sessionUser = 'b';
    holdDeals = false;
    const before = dealsCalls();
    act(() => auth.callback!('SIGNED_IN', { user: { id: 'b' } }));

    expect(await screen.findAllByText('Project Bravo Only')).toHaveLength(2);
    expect(dealsCalls()).toBe(before + 1);
    // The signed-out read settles late and is dropped.
    await act(async () => heldDeals[0]());
    expect(rendered).not.toContain('Project Alpha Only');
    expect(screen.queryByText('Project Alpha Only')).not.toBeInTheDocument();
    expect(screen.getAllByText('Project Bravo Only')).toHaveLength(2);
  });

  it('(c) same-user SIGNED_IN and USER_UPDATED re-emits issue no new /deals or /rail', async () => {
    await mountProbe(true);
    expect(await screen.findAllByText('Project Alpha Only')).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId('rail')).not.toHaveTextContent('loading'));
    const deals = dealsCalls();
    const rail = railCalls();
    expect(deals).toBe(1);
    expect(rail).toBe(1);

    act(() => auth.callback!('SIGNED_IN', { user: { id: 'a' } }));
    act(() => auth.callback!('USER_UPDATED', { user: { id: 'a' } }));
    act(() => auth.callback!('TOKEN_REFRESHED', { user: { id: 'a' } }));
    await act(async () => {});

    expect(dealsCalls()).toBe(deals);
    expect(railCalls()).toBe(rail);
    expect(screen.getAllByText('Project Alpha Only')).toHaveLength(2);
  });

  it('(d) a failed signOut() in the Sidebar re-enables the button and re-reads the list once as the same user', async () => {
    auth.signOut = vi.fn(async () => {
      throw new Error('network');
    });
    const { FlagsProvider } = await import('@/lib/flags/FlagsContext');
    const { Sidebar } = await import('@/components/organisms/navigation/Sidebar');
    const { useDeals } = await import('@/lib/deals/useDeals');
    function DealsProbe() {
      const { state, deals } = useDeals();
      return (
        <p data-testid="probe">
          {state.status}:{deals.map((d) => d.codename).join(',')}
        </p>
      );
    }
    render(
      <FlagsProvider value={flags()}>
        <Sidebar collapsed={false} onToggle={() => {}} />
        <DealsProbe />
      </FlagsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('ready:Project Alpha Only'),
    );
    expect(dealsCalls()).toBe(1);

    const logout = screen.getByRole('button', { name: 'Logout' });
    await act(async () => {
      fireEvent.click(logout);
    });

    await waitFor(() => expect(logout).not.toBeDisabled());
    await waitFor(() =>
      expect(screen.getByTestId('probe')).toHaveTextContent('ready:Project Alpha Only'),
    );
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(dealsCalls()).toBe(2);
  });
});
