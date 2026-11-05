import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';

import { TopNav } from '@/components/organisms/navigation';
import { Sidebar } from '@/components/organisms/navigation/Sidebar';
import { AppNav, PHONE_BAR_MAX, splitPhoneBar } from '@/components/shell/AppNav';
import { unreadFor } from '@/components/notifications/NavCountBadge';
import { badgeHref } from '@/lib/notifications/navBadges';
import { useNotifications, VISIBILITY_RELOAD_MIN_MS, type AppNotification } from '@/lib/notifications/useNotifications';
import { SessionProvider } from '../src/lib/session/store';

const { usePathnameMock, dealList } = vi.hoisted(() => ({
  usePathnameMock: vi.fn(),
  // false: useDeals answers as it does while the API list is still loading.
  dealList: { resolved: true },
}));

vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: () => false }));
vi.mock('next/navigation', () => ({
  usePathname: usePathnameMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/useCurrentUser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/useCurrentUser')>();
  return {
    ...actual,
    useCurrentUser: () => ({
      state: {
        status: 'ready',
        data: {
          user: {
            id: 'u-1',
            email: 'md@bank.test',
            full_name: 'Storm Duncan',
            display_name: 'Storm Duncan',
            firm_role: null,
            department: null,
            is_external: false,
            status: 'active',
            company_id: 'c-1',
            company_role: 'director',
            can_invite: true,
          },
          mandate: null,
        },
      },
    }),
  };
});
vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  // The open deal, as the API list gives it: routed by code, with its UUID.
  const summit = {
    id: 'project-summit',
    code: 'SUM-2026-001',
    codename: 'Project Summit',
    target: 'Atlassian',
    sector: '',
    status: 'Execution',
    cursorStepId: 'p2-s26',
    entryStepSeq: 1,
    gate0Complete: true,
    dealRole: 'Lead Banker',
    uuid: 'd-summit',
  };
  return {
    ...actual,
    useDeals: () =>
      dealList.resolved
        ? { deals: [summit] }
        : { deals: [], loading: true, error: false, state: { status: 'loading' } },
  };
});
vi.mock('@/lib/access/useAccessInbox', () => ({
  useAccessInbox: () => ({ match: () => null, decide: vi.fn(), busyId: null }),
}));
vi.mock('@/components/deals/DealSelect', () => ({
  SidebarDealSelect: () => null,
  DealSelectMenu: () => null,
  DealSelectMenuFooter: () => null,
}));
vi.mock('@/components/wizard/NewMandateDialog', () => ({ NewMandateDialog: () => null }));

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const note = (id: string, event_type: string, extra: Partial<AppNotification> = {}): AppNotification => ({
  id,
  deal_id: 'd-summit',
  event_type,
  payload: {},
  read_at: null,
  created_at: at(10),
  ...extra,
});

const FEED: AppNotification[] = [
  note('m-old', 'mail_queued_for_review', { created_at: at(30) }),
  note('m-new', 'mail_queued_for_review', {
    created_at: at(1),
    payload: { href: '/projects/d-summit/mail?folder=held' },
  }),
  // Another deal's held mail: never on Summit's Mail pill.
  note('m-other', 'mail_queued_for_review', { deal_id: 'd-alder', created_at: at(0) }),
  note('t-1', 'member_added'),
  note('r-read', 'step_assigned', { read_at: at(5) }),
  note('s-1', 'mailbox_connected', { deal_id: null }),
  // A permission request is about the firm: Settings, never Team.
  note('a-1', 'access_requested', { deal_id: null, created_at: at(2) }),
  note('x-1', 'deal_created'),
];
const SUMMIT_SCOPE = { segment: 'project-summit', uuid: 'd-summit' };

function stubFeed(feed: AppNotification[] = FEED) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Promise.resolve(new Response('{}', { status: 200 }));
    if (String(input) === '/api/v1/notifications') {
      return Promise.resolve(new Response(JSON.stringify({ notifications: feed }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const feedCalls = (fetchMock: ReturnType<typeof stubFeed>) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input) === '/api/v1/notifications' && !init?.method).length;

beforeEach(() => {
  usePathnameMock.mockReturnValue('/projects/project-summit/rail');
  dealList.resolved = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('unreadFor', () => {
  it('counts unread per place and picks the newest', () => {
    expect(unreadFor(FEED, 'mail')).toEqual({ count: 3, latest: FEED[2] });
    expect(unreadFor(FEED, 'team').count).toBe(1);
    expect(unreadFor(FEED, 'rails')).toEqual({ count: 0, latest: null });
    expect(unreadFor(FEED, 'settings').count).toBe(2);
  });

  it('scopes a per-deal pill to the open deal: by UUID, by code, or by a UUID route', () => {
    expect(unreadFor(FEED, 'mail', SUMMIT_SCOPE)).toEqual({ count: 2, latest: FEED[1] });
    const step = note('st', 'step_assigned', { deal_id: 'd-zzz', payload: { code: 'SUM-2026-001' } });
    expect(unreadFor([step], 'rails', { segment: 'SUM-2026-001', uuid: null }).count).toBe(1);
    expect(unreadFor([step], 'rails', { segment: 'OTHER-1', uuid: null }).count).toBe(0);
    expect(unreadFor(FEED, 'mail', { segment: 'd-alder', uuid: null }).count).toBe(1);
  });
});

describe('badge links open the deal by its code, never its UUID', () => {
  const UUID = '8a642fdf-1b2c-4d5e-8f90-123456789abc';

  it('prefers the code over the deal UUID', () => {
    const step = note('s1', 'step_completed', { deal_id: UUID, payload: { code: 'SUMMIT-2026-003' } });
    expect(badgeHref(step)).toBe('/projects/SUMMIT-2026-003/rail');
  });

  it('rewrites a UUID in a stored link to the code, keeping the rest', () => {
    const hold = note('h1', 'compliance_hold', {
      deal_id: UUID,
      payload: { code: 'SUMMIT-2026-003', href: `/projects/${UUID}/mail?folder=held` },
    });
    expect(badgeHref(hold)).toBe('/projects/SUMMIT-2026-003/mail?folder=held');
  });

  it('keeps the UUID when there is no code', () => {
    const step = note('s2', 'step_completed', { deal_id: UUID });
    expect(badgeHref(step)).toBe(`/projects/${UUID}/rail`);
    const hold = note('h2', 'compliance_hold', { deal_id: UUID, payload: { href: `/projects/${UUID}/mail?folder=held` } });
    expect(badgeHref(hold)).toBe(`/projects/${UUID}/mail?folder=held`);
  });
});

describe('the notifications feed', () => {
  it('is one request for every reader, and a mark read shows in all of them', async () => {
    const fetchMock = stubFeed();
    const a = renderHook(() => useNotifications());
    const b = renderHook(() => useNotifications());
    await waitFor(() => expect(a.result.current.unreadCount).toBe(7));
    expect(b.result.current.unreadCount).toBe(7);
    expect(feedCalls(fetchMock)).toBe(1);

    await act(async () => {
      await a.result.current.markRead('m-new');
    });
    expect(b.result.current.unreadCount).toBe(6);
  });

  it('reads again when the tab regains focus or becomes visible, past the reload window', async () => {
    // The hook throttles focus and visibility reloads (#173 G-04); the clock steps past the window each time.
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = stubFeed();
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(feedCalls(fetchMock)).toBe(1);

    now += VISIBILITY_RELOAD_MIN_MS + 1_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(feedCalls(fetchMock)).toBe(2));

    now += VISIBILITY_RELOAD_MIN_MS + 1_000;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(feedCalls(fetchMock)).toBe(3));
    clock.mockRestore();
  });
});

describe('nav count badges', () => {
  it('TopNav: this deal\'s counts on Mail and Team, none on Rails (all read), Settings on the avatar, bell kept', async () => {
    stubFeed();
    render(
      <SessionProvider>
        <TopNav />
      </SessionProvider>,
    );
    const mail = await screen.findByRole('link', { name: 'Mail: 2 unread' });
    expect(mail).toHaveTextContent('2');
    // Deep link: the newest unread one's own href.
    expect(mail).toHaveAttribute('href', '/projects/d-summit/mail?folder=held');
    expect(screen.getByRole('link', { name: 'Team: 1 unread' })).toHaveAttribute('href', '/projects/d-summit/team');
    // The newest Settings item is the permission request: Organization › Permission requests.
    expect(screen.getByRole('link', { name: 'Settings: 2 unread' })).toHaveAttribute(
      'href',
      '/settings?section=organization&tab=requests',
    );
    expect(screen.queryByRole('link', { name: /^Rails: / })).not.toBeInTheDocument();
    // The nav links keep their frozen names; the bell still holds everything.
    expect(screen.getByRole('link', { name: 'Mail' })).toHaveAttribute('href', '/projects/project-summit/mail');
    expect(screen.getByRole('button', { name: 'Notifications, 7 unread' })).toBeInTheDocument();
  });

  it('while the deal list is unresolved, a notification that carries only deal_id is left off the pill until the list loads', async () => {
    // Pinned on purpose: a notification names its deal by UUID, and the nav
    // knows only the code in the URL. Until the deal list maps that code to
    // its UUID, the scope has no UUID, so a deal_id-only notification cannot
    // be placed on this deal and the pill undercounts. It is never shown on a
    // guess; the bell still counts it. The stored link fix is handoff E33.
    usePathnameMock.mockReturnValue('/projects/SUM-2026-001/rail');
    dealList.resolved = false;
    stubFeed([note('st-1', 'step_assigned', { deal_id: 'd-summit', payload: {} })]);
    const { rerender } = render(
      <SessionProvider>
        <TopNav />
      </SessionProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Notifications, 1 unread' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Rails: / })).not.toBeInTheDocument();

    dealList.resolved = true;
    rerender(
      <SessionProvider>
        <TopNav />
      </SessionProvider>,
    );
    expect(await screen.findByRole('link', { name: 'Rails: 1 unread' })).toBeInTheDocument();
  });

  it('opening a badge marks that notification read, so the count goes down', async () => {
    const fetchMock = stubFeed();
    render(
      <SessionProvider>
        <TopNav />
      </SessionProvider>,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Mail: 2 unread' }));
    expect(await screen.findByRole('link', { name: 'Mail: 1 unread' })).toHaveAttribute(
      'href',
      '/projects/d-summit/mail',
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/notifications/m-new', expect.objectContaining({ method: 'PATCH' }));
  });

  it('Sidebar: counts on Mail, Team and Settings', async () => {
    stubFeed();
    render(<Sidebar collapsed={false} onToggle={() => {}} />);
    expect(await screen.findByRole('link', { name: 'Mail: 2 unread' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Team: 1 unread' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings: 2 unread' })).toBeInTheDocument();
  });

  it('AppNav bottom bar on a deal: five cells plus More; More rolls up what it holds', async () => {
    stubFeed();
    render(<AppNav layout="bottom-bar" />);
    const bar = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(await within(bar).findByRole('link', { name: 'Mail: 2 unread' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Team: 1 unread' })).toBeInTheDocument();
    const cells = Array.from(bar.querySelectorAll('ul > li'));
    expect(cells).toHaveLength(PHONE_BAR_MAX + 1);
    // One-line name in the cell, the full name as its accessible name.
    const home = within(bar).getByRole('link', { name: 'Conductor Center' });
    expect(home).toHaveTextContent('Conductor');
    // Settings sits under More; its two unread roll up onto More.
    expect(within(bar).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    const more = within(bar).getByRole('button', { name: 'More, 2 unread' });
    expect(bar.querySelector('[data-nav-badge="more"]')).toHaveTextContent('2');
    fireEvent.keyDown(more, { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'Settings · 2 unread' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('render nothing with nothing unread', async () => {
    const fetchMock = stubFeed([note('r', 'mail_queued_for_review', { read_at: at(1) })]);
    render(<AppNav layout="bottom-bar" />);
    await waitFor(() => expect(feedCalls(fetchMock)).toBe(1));
    expect(document.querySelector('[data-nav-badge]')).toBeNull();
  });
});

describe('AppNav Settings entry', () => {
  it('is in the bottom bar off a deal (no More when five or fewer), and active on /settings', () => {
    stubFeed([]);
    usePathnameMock.mockReturnValue('/settings');
    render(<AppNav layout="bottom-bar" />);
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: /^More/ })).not.toBeInTheDocument();
  });
});

describe('splitPhoneBar: five entries plus More', () => {
  const ids = (list: { id: string }[]) => list.map((e) => e.id);
  const e = (id: string) => ({ id });

  it('on a deal: Conductor Center, Rails, Team, Mail, Deal Folder; the rest under More', () => {
    const all = ['command-center', 'mandate', 'rail', 'team', 'mail', 'dealFolder', 'dataRoom', 'audit', 'ai-costs', 'settings'].map(e);
    const { primary, more } = splitPhoneBar(all, true);
    expect(ids(primary)).toEqual(['command-center', 'rail', 'team', 'mail', 'dealFolder']);
    expect(ids(more)).toEqual(['mandate', 'dataRoom', 'audit', 'ai-costs', 'settings']);
  });

  it('off a deal: Conductor Center, Leads, Discovery, Rails configuration, AI Costs; Settings under More', () => {
    const all = ['command-center', 'leads', 'discovery', 'ai-costs', 'rail-templates', 'settings'].map(e);
    const { primary, more } = splitPhoneBar(all, false);
    expect(ids(primary)).toEqual(['command-center', 'leads', 'discovery', 'rail-templates', 'ai-costs']);
    expect(ids(more)).toEqual(['settings']);
  });

  it('shows five or fewer without More', () => {
    const { primary, more } = splitPhoneBar(['command-center', 'leads', 'settings'].map(e), false);
    expect(ids(primary)).toEqual(['command-center', 'leads', 'settings']);
    expect(more).toEqual([]);
  });
});

describe('AppNav bottom bar height', () => {
  it('publishes its height as --app-nav-h for the shell to reserve, and clears it on unmount', () => {
    stubFeed([]);
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = vi.fn();
      },
    );
    const { unmount } = render(<AppNav layout="bottom-bar" />);
    expect(observe).toHaveBeenCalledWith(screen.getByRole('navigation', { name: 'Primary navigation' }));
    expect(document.documentElement.style.getPropertyValue('--app-nav-h')).toBe('0px');
    unmount();
    expect(document.documentElement.style.getPropertyValue('--app-nav-h')).toBe('');
  });
});
