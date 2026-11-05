import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, renderHook, act } from '@testing-library/react';
import * as React from 'react';

import { useNotifications, VISIBILITY_RELOAD_MIN_MS } from '../src/lib/notifications/useNotifications';
import { useAccessInbox } from '../src/lib/access/useAccessInbox';
import { NotificationsBell } from '../src/components/notifications/NotificationsBell';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

const SAMPLE = [
  {
    id: 'n1',
    deal_id: 'd1',
    event_type: 'deal_created',
    payload: { code: 'FALCO-2026-123', codename: 'Project Falcon', actor: 'Storm Duncan' },
    read_at: null,
    created_at: new Date().toISOString(),
  },
  {
    id: 'n2',
    deal_id: 'd2',
    event_type: 'deal_created',
    payload: { code: 'HERON-2026-004' },
    read_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'visibilityState');
});

// ── #173 G-04 helpers: a feed that answers in turn, a clock, the tab's visibility ──

type Answer = Response | Promise<Response> | (() => Promise<Response>);

/** fetch for the bell: the feed answers in turn (the last answer repeats), everything else is empty. */
function feedStub(answers: Answer[]) {
  let call = 0;
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/v1/notifications') {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return typeof answer === 'function' ? answer() : Promise.resolve(answer);
    }
    if (url === '/api/v1/access-requests') return Promise.resolve(jsonResponse(200, { inbox: [] }));
    return Promise.resolve(jsonResponse(200, {}));
  });
}

function feedCalls(fetchMock: ReturnType<typeof feedStub>): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === '/api/v1/notifications').length;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every pending fetch and state update land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Date.now under the test's control; the hook's 30 s throttle reads it. */
function clock(start = 1_800_000_000_000) {
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

function tabBecomes(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const feed = (notifications: unknown[]) => jsonResponse(200, { notifications });

const REFUSAL = {
  id: 'n-refused',
  deal_id: null,
  event_type: 'team_mailbox_refused',
  payload: { teamMailboxId: 'tm-1', address: 'deals@bank.example', reason: 'directory_denied', href: '/discovery' },
  read_at: null,
  created_at: new Date().toISOString(),
};

describe('useNotifications', () => {
  it('loads notifications and counts unread', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(200, { notifications: SAMPLE }))));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items).toHaveLength(2);
    expect(result.current.unreadCount).toBe(1);
  });

  it('reads the feed with cache no-store, like /me (#162)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { notifications: SAMPLE })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/notifications',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    );
  });

  it('fails safe to an empty feed on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(401, { error: 'x' }))));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.items).toHaveLength(0);
    expect(result.current.unreadCount).toBe(0);
  });

  it('markRead optimistically clears unread and PATCHes', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/notifications')) {
        return Promise.resolve(jsonResponse(200, { notifications: SAMPLE }));
      }
      return Promise.resolve(jsonResponse(200, { notification: {} }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    await act(async () => {
      await result.current.markRead('n1');
    });
    expect(result.current.unreadCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/notifications/n1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});

describe('useAccessInbox', () => {
  it('reads the inbox with cache no-store, like /me (#162)', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { inbox: [] })));
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAccessInbox());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/access-requests',
        expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
      ),
    );
  });
});

describe('NotificationsBell', () => {
  it('shows the unread badge and lists notifications on open', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(200, { notifications: SAMPLE }))));
    render(<NotificationsBell />);

    // Badge reflects the single unread item.
    const trigger = await screen.findByRole('button', { name: /1 unread/i });
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog', { name: /notifications/i })).toBeInTheDocument();
    // The subtitle names the deal by its codename; the raw code stays in the link only.
    expect(screen.getByText('Project Falcon · Storm Duncan')).toBeInTheDocument();
    expect(screen.queryByText(/FALCO-2026-123/)).toBeNull();
    expect(screen.getAllByText('New mandate opened').length).toBeGreaterThan(0);
    // One unread → one "Mark read" affordance.
    expect(screen.getAllByRole('button', { name: /mark read/i })).toHaveLength(1);
  });

  it('lets an administrator approve an access request from the bell', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/notifications') {
        return Promise.resolve(
          jsonResponse(200, {
            notifications: [
              {
                id: 'n-access',
                deal_id: null,
                event_type: 'access_requested',
                payload: {
                  actor: 'Rob',
                  destinationLabel: 'Leads',
                  href: '/leads',
                  requestId: 'req-1',
                  companyId: 'co-1',
                },
                read_at: null,
                created_at: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/access-requests' && !init?.method) {
        return Promise.resolve(
          jsonResponse(200, {
            inbox: [
              {
                id: 'req-1',
                requesterName: 'Rob',
                destinationLabel: 'Leads',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/access-requests/req-1') {
        return Promise.resolve(jsonResponse(200, { request: { id: 'req-1', status: 'approved' } }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    expect(screen.queryByRole('link', { name: 'Access request' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/access-requests/req-1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull());
  });

  it('lets an administrator deny an access request from the bell', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/notifications') {
        return Promise.resolve(
          jsonResponse(200, {
            notifications: [
              {
                id: 'n-access',
                deal_id: null,
                event_type: 'access_requested',
                payload: {
                  actor: 'Rob',
                  destinationLabel: 'Leads',
                  href: '/leads',
                  requestId: 'req-1',
                  companyId: 'co-1',
                },
                read_at: null,
                created_at: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/access-requests' && !init?.method) {
        return Promise.resolve(
          jsonResponse(200, {
            inbox: [
              {
                id: 'req-1',
                requesterName: 'Rob',
                destinationLabel: 'Leads',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/access-requests/req-1') {
        return Promise.resolve(jsonResponse(200, { request: { id: 'req-1', status: 'denied' } }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/access-requests/req-1',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ decision: 'denied' }) }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('hides approve/deny once the request is no longer pending', async () => {
    const accessRequested = {
      id: 'n-access',
      deal_id: null,
      event_type: 'access_requested',
      payload: {
        actor: 'Martín',
        destinationLabel: 'Leads',
        href: '/leads',
        requestId: 'req-decided',
        companyId: 'co-1',
      },
      read_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/notifications') {
          return Promise.resolve(jsonResponse(200, { notifications: [accessRequested] }));
        }
        if (url === '/api/v1/access-requests') {
          return Promise.resolve(jsonResponse(200, { inbox: [] }));
        }
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Access request')).toBeInTheDocument();
    expect(screen.getByText(/Leads · Martín/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  it('drops the buttons when a decide call reports the request is already decided', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/notifications') {
        return Promise.resolve(
          jsonResponse(200, {
            notifications: [
              {
                id: 'n-access',
                deal_id: null,
                event_type: 'access_requested',
                payload: {
                  actor: 'Martín',
                  destinationLabel: 'Leads',
                  href: '/leads',
                  requestId: 'req-1',
                  companyId: 'co-1',
                },
                read_at: null,
                created_at: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/access-requests' && !init?.method) {
        return Promise.resolve(
          jsonResponse(200, {
            inbox: [
              {
                id: 'req-1',
                requesterName: 'Martín',
                destinationLabel: 'Leads',
                createdAt: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (url === '/api/v1/access-requests/req-1') {
        return Promise.resolve(
          jsonResponse(409, { error: 'This request has already been decided' }),
        );
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
  });

  // #262 A2: the firm admin is told when a member connects a mailbox; the row names the address, never "a deal".
  it('names the member address on a mailbox_connected notification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            notifications: [
              {
                id: 'n9',
                deal_id: null,
                event_type: 'mailbox_connected',
                payload: { address: 'storm.duncan@bank.example', outcome: 'created' },
                read_at: null,
                created_at: new Date().toISOString(),
              },
            ],
          }),
        ),
      ),
    );
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    expect(screen.getByText('Mailbox connected')).toBeInTheDocument();
    expect(screen.getByText(/storm\.duncan@bank\.example/)).toBeInTheDocument();
    expect(screen.queryByText(/a deal/)).toBeNull();
  });

  // #173 G-04: a Directory refusal of a team inbox names the inbox and a short reason, and opens /discovery.
  it('names the inbox and the short reason on a team inbox refusal, linking to /discovery', async () => {
    vi.stubGlobal('fetch', feedStub([feed([REFUSAL])]));
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    expect(screen.getByRole('link', { name: 'Team inbox failed the address check' })).toHaveAttribute('href', '/discovery');
    expect(screen.getByText('deals@bank.example · Directory read not granted')).toBeInTheDocument();
    expect(screen.queryByText(/a deal/)).toBeNull();
  });

  it('reads the drift notice by its counts, or as an unreadable group, never "a deal"', async () => {
    const drift = (id: string, payload: Record<string, unknown>) => ({
      id,
      deal_id: null,
      event_type: 'mailbox_allowlist_drift',
      payload,
      read_at: null,
      created_at: new Date().toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      feedStub([
        feed([
          drift('n-d1', { provider: 'google', status: 'drift', missingCount: 1, extraCount: 0 }),
          drift('n-d2', { provider: 'google', status: 'unavailable', missingCount: 0, extraCount: 0 }),
        ]),
      ]),
    );
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /2 unread/i }));
    expect(screen.getByText('1 missing, 0 extra')).toBeInTheDocument();
    expect(screen.getByText('Provider group could not be read')).toBeInTheDocument();
    expect(screen.queryByText(/a deal/)).toBeNull();
  });

  it('shows a notice that arrived after mount when the bell is opened, and reads nothing when it closes', async () => {
    const fetchMock = feedStub([feed([]), feed([REFUSAL])]);
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    await settle();
    expect(feedCalls(fetchMock)).toBe(1);
    const trigger = screen.getByRole('button', { name: 'Notifications' });
    fireEvent.click(trigger);
    expect(await screen.findByText('Team inbox failed the address check')).toBeInTheDocument();
    expect(feedCalls(fetchMock)).toBe(2);
    expect(screen.getByRole('button', { name: /1 unread/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /1 unread/i }));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(feedCalls(fetchMock)).toBe(2);
  });

  it('shows a notice that arrived after mount when the tab becomes visible again', async () => {
    const time = clock();
    const fetchMock = feedStub([feed([]), feed([REFUSAL])]);
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    await settle();
    time.advance(VISIBILITY_RELOAD_MIN_MS + 1_000);
    tabBecomes('visible');
    expect(await screen.findByRole('button', { name: /1 unread/i })).toBeInTheDocument();
    expect(feedCalls(fetchMock)).toBe(2);
  });

  it('keeps the items and the badge when a reload fails', async () => {
    const time = clock();
    const fetchMock = feedStub([
      feed(SAMPLE),
      jsonResponse(500, { error: 'down' }),
      () => Promise.reject(new Error('offline')),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    fireEvent.click(await screen.findByRole('button', { name: /1 unread/i }));
    await settle();
    expect(feedCalls(fetchMock)).toBe(2);
    expect(screen.getByRole('button', { name: /1 unread/i })).toBeInTheDocument();
    // The rows name the deal by its codename; a deal with none reads "a deal".
    expect(screen.getByText('Project Falcon · Storm Duncan')).toBeInTheDocument();
    expect(screen.getByText('a deal')).toBeInTheDocument();
    // A thrown fetch on a visibility reload keeps them too.
    time.advance(VISIBILITY_RELOAD_MIN_MS + 1_000);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(3);
    expect(screen.getByRole('button', { name: /1 unread/i })).toBeInTheDocument();
    expect(screen.getByText('Project Falcon · Storm Duncan')).toBeInTheDocument();
  });

  it('skips a visibility reload within 30 s of the last load, while opening the bell still reads', async () => {
    const time = clock();
    const fetchMock = feedStub([feed(SAMPLE)]);
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    await settle();
    expect(feedCalls(fetchMock)).toBe(1);

    time.advance(10_000);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /1 unread/i }));
    await settle();
    expect(feedCalls(fetchMock)).toBe(2);

    // The open's load restarts the window.
    time.advance(VISIBILITY_RELOAD_MIN_MS - 10_000);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(2);

    time.advance(11_000);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(3);

    // A tab going hidden reads nothing, however long it has been.
    time.advance(VISIBILITY_RELOAD_MIN_MS + 1_000);
    tabBecomes('hidden');
    await settle();
    expect(feedCalls(fetchMock)).toBe(3);
  });

  it('renders quietly (no badge) when there are no notifications', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(200, { notifications: [] }))));
    render(<NotificationsBell />);
    // The label has no "unread" suffix when the feed is empty.
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });
});

// #173 G-04: the hook's reloads never stack, never go backwards and never resurrect a read item.
describe('useNotifications freshness', () => {
  it('issues one fetch for overlapping loads, the open and the tab included', async () => {
    const time = clock();
    const first = deferred<Response>();
    const fetchMock = feedStub([first.promise, feed([])]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications());
    expect(feedCalls(fetchMock)).toBe(1);
    time.advance(VISIBILITY_RELOAD_MIN_MS + 1_000);
    let joined: Promise<void> = Promise.resolve();
    act(() => {
      joined = result.current.reload({ force: true });
      void result.current.reload({ force: true });
    });
    tabBecomes('visible');
    expect(feedCalls(fetchMock)).toBe(1);
    await act(async () => {
      first.resolve(feed(SAMPLE));
      await joined;
    });
    expect(result.current.items).toHaveLength(2);
    expect(feedCalls(fetchMock)).toBe(1);
  });

  it('applies only the newest response: a slower, older one that lands last is dropped', async () => {
    // StrictMode runs the mount effect twice, so two loads overlap the way a remount makes them.
    const older = deferred<Response>();
    const newer = deferred<Response>();
    const fetchMock = feedStub([older.promise, newer.promise]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications(), { wrapper: React.StrictMode });
    expect(feedCalls(fetchMock)).toBe(2);
    await act(async () => {
      newer.resolve(feed([REFUSAL]));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.items.map((n) => n.id)).toEqual(['n-refused']);
    await act(async () => {
      older.resolve(feed(SAMPLE));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.items.map((n) => n.id)).toEqual(['n-refused']);
    expect(result.current.unreadCount).toBe(1);
  });

  it('keeps an item marked read when an older response that has it unread lands afterwards', async () => {
    const stale = deferred<Response>();
    const readOnServer = SAMPLE.map((n) => (n.id === 'n1' ? { ...n, read_at: new Date().toISOString() } : n));
    const fetchMock = feedStub([feed(SAMPLE), stale.promise, feed(readOnServer), feed(SAMPLE)]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));

    let reloading: Promise<void> = Promise.resolve();
    act(() => {
      reloading = result.current.reload({ force: true });
    });
    await act(async () => {
      await result.current.markRead('n1');
    });
    expect(result.current.unreadCount).toBe(0);
    await act(async () => {
      stale.resolve(feed(SAMPLE));
      await reloading;
    });
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.items.find((n) => n.id === 'n1')?.read_at).toBeTruthy();

    // Once the server shows it read, the local mark is no longer needed: the server is what is shown from then on.
    await act(async () => {
      await result.current.reload({ force: true });
    });
    expect(result.current.unreadCount).toBe(0);
    await act(async () => {
      await result.current.reload({ force: true });
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it('lets the next load show the server when a mark-read was not saved', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/v1/notifications' && !init?.method) return Promise.resolve(feed(SAMPLE));
      return Promise.resolve(jsonResponse(500, { error: 'down' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    await act(async () => {
      await result.current.markRead('n1');
    });
    // The branch's refused-mark-read rule puts the item back at once, and names it.
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.markReadFailedId).toBe('n1');
    await act(async () => {
      await result.current.reload({ force: true });
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it('throttles visibility reloads on the attempt, so a failing feed is not asked again on every tab switch', async () => {
    const time = clock();
    const fetchMock = feedStub([jsonResponse(500, { error: 'down' })]);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications());
    await settle();
    expect(feedCalls(fetchMock)).toBe(1);

    // The mount load failed; a show within 30 s of it asks nothing.
    time.advance(10_000);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(1);

    // Past the window, the next show asks again; it fails too, and restarts the window.
    time.advance(VISIBILITY_RELOAD_MIN_MS);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(2);
    time.advance(10_000);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(2);

    // Opening the bell is forced, failing feed or not.
    await act(async () => {
      await result.current.reload({ force: true });
    });
    expect(feedCalls(fetchMock)).toBe(3);
  });

  // React 19 drops a set-state after unmount silently, so this pins the outcome (no render, no warning); the guard
  // itself is what the StrictMode remount test above fails without.
  it('ignores a response that lands after unmount', async () => {
    const late = deferred<Response>();
    const fetchMock = feedStub([late.promise]);
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error');
    let renders = 0;
    const { result, unmount } = renderHook(() => {
      renders += 1;
      return useNotifications();
    });
    expect(feedCalls(fetchMock)).toBe(1);
    const rendersBefore = renders;
    unmount();
    await act(async () => {
      late.resolve(feed(SAMPLE));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(renders).toBe(rendersBefore);
    expect(result.current.items).toEqual([]);
    expect(result.current.ready).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('stops listening to the tab when it unmounts', async () => {
    const time = clock();
    const fetchMock = feedStub([feed(SAMPLE)]);
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderHook(() => useNotifications());
    await settle();
    expect(feedCalls(fetchMock)).toBe(1);
    unmount();
    time.advance(VISIBILITY_RELOAD_MIN_MS + 1_000);
    tabBecomes('visible');
    await settle();
    expect(feedCalls(fetchMock)).toBe(1);
  });
});
