import * as React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * #331: the person a network node focuses rides in the URL fragment, not the
 * query. router.push uses history.pushState, which never fires hashchange, and
 * the tab and lead are unchanged on a second click, so the search string does
 * not change either. The page therefore reads the focused person from a small
 * store that pushCrmFocus writes directly (and hashchange / a deep link feed).
 */

const SEARCH = vi.hoisted(() => ({ current: null as URLSearchParams | null }));
const useCurrentUserMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  // One stable object per render pass: a new URLSearchParams on every call would
  // re-run any effect keyed on it, which is exactly the bug this test pins.
  useSearchParams: () => SEARCH.current,
}));
vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: useCurrentUserMock }));
vi.mock('@/components/leads/LeadList', () => ({
  LeadList: ({ focusLeadId, focusPersonName }: { focusLeadId?: string; focusPersonName?: string }) => (
    <div data-testid="lead-list">{`lead=${focusLeadId ?? ''} person=${focusPersonName ?? ''}`}</div>
  ),
}));
vi.mock('@/components/leads/PeopleList', () => ({ PeopleList: () => <div>People catalog</div> }));
vi.mock('@/components/leads/CrmNetworkPreview', () => ({ CrmNetworkPreview: () => <div>Network catalog</div> }));

import LeadsPageClient from '@/app/(authed)/leads/page.client';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { publishCrmFocus } from '@/lib/leads/crmFocusStore';
import { crmLeadsHrefForNetworkNode, pushCrmFocus } from '@/lib/leads/crmLeadsNavigation';

function readyUser() {
  useCurrentUserMock.mockReturnValue({
    state: {
      status: 'ready',
      data: {
        user: { id: 'u1', is_external: false, firm_role: null, company_id: 'co-1', company_role: 'member' },
        company: { id: 'co-1', name: 'Conductia' },
        company_permissions: [
          { permissionKey: COMPANY_PERMISSION.LEADS_VIEW, source: { type: 'direct', id: null, name: null } },
        ],
      },
    },
  });
}

/** A router whose push behaves like Next's: pushState, which does NOT fire hashchange. */
function historyRouter() {
  return {
    push: (href: string) => {
      window.history.pushState(null, '', href);
    },
  };
}

const focused = () => screen.getByTestId('lead-list').textContent;

beforeEach(() => {
  readyUser();
  SEARCH.current = new URLSearchParams('tab=companies&lead=lead-1');
  window.history.replaceState(null, '', '/leads?tab=companies&lead=lead-1');
  publishCrmFocus(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('leads page: person focus from the URL fragment', () => {
  it('highlights the person named in a #person= deep link on mount', () => {
    window.history.replaceState(null, '', '/leads?tab=companies&lead=lead-1#person=Ada+Lovelace');
    render(<LeadsPageClient />);
    expect(focused()).toBe('lead=lead-1 person=Ada Lovelace');
  });

  it('does not read a person from the query string', () => {
    SEARCH.current = new URLSearchParams('tab=companies&lead=lead-1&person=Ada+Lovelace');
    render(<LeadsPageClient />);
    expect(focused()).toBe('lead=lead-1 person=');
  });

  it('moves the highlight to a second person on the same lead and tab', () => {
    render(<LeadsPageClient />);
    expect(focused()).toBe('lead=lead-1 person=');
    const router = historyRouter();

    act(() => {
      pushCrmFocus(router, crmLeadsHrefForNetworkNode('lead-1', 'Ada Lovelace'), 'Ada Lovelace');
    });
    expect(focused()).toBe('lead=lead-1 person=Ada Lovelace');
    expect(window.location.hash).toBe('#person=Ada+Lovelace');
    expect(window.location.search).toBe('?tab=companies&lead=lead-1');

    // Only the fragment changes: the search params object the page sees is the same one.
    act(() => {
      pushCrmFocus(router, crmLeadsHrefForNetworkNode('lead-1', 'Grace Hopper'), 'Grace Hopper');
    });
    expect(focused()).toBe('lead=lead-1 person=Grace Hopper');
    expect(window.location.hash).toBe('#person=Grace+Hopper');
  });

  it('follows a hand-edited fragment (hashchange)', async () => {
    render(<LeadsPageClient />);
    act(() => {
      pushCrmFocus(historyRouter(), crmLeadsHrefForNetworkNode('lead-1', 'Ada Lovelace'), 'Ada Lovelace');
    });
    expect(focused()).toBe('lead=lead-1 person=Ada Lovelace');

    act(() => {
      window.location.hash = '#person=Linus+Torvalds';
    });
    await waitFor(() => expect(focused()).toBe('lead=lead-1 person=Linus Torvalds'));

    act(() => {
      window.location.hash = '';
    });
    await waitFor(() => expect(focused()).toBe('lead=lead-1 person='));
  });

  it('forgets a previous visit focus when the page mounts on a URL with no fragment', () => {
    publishCrmFocus('Stale Person');
    render(<LeadsPageClient />);
    expect(focused()).toBe('lead=lead-1 person=');
  });
});
