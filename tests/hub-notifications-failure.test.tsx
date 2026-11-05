import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

import { useNotifications, VISIBILITY_RELOAD_MIN_MS } from '../src/lib/notifications/useNotifications';
import { NotificationsBell } from '../src/components/notifications/NotificationsBell';

/*
 * A failed notifications read is not an
 * empty desk, and a failed refetch never wipes the last good feed.
 * A refused mark-read puts the item back.
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

const now = new Date().toISOString();
const SIX = Array.from({ length: 6 }, (_, i) => ({
  id: `n${i}`,
  deal_id: 'd1',
  event_type: 'step_assigned',
  payload: { code: 'FALCN-2026-777', codename: 'Falcon', actor: 'Rob', stepTitle: `Step ${i}` },
  read_at: null,
  created_at: now,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Steps Date.now past the hook's focus/visibility reload window (#173 G-04). */
function pastReloadWindow() {
  const later = Date.now() + VISIBILITY_RELOAD_MIN_MS + 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => later);
}

describe('useNotifications failure states', () => {
  it('a first-load failure gives ready true and error set, with no items', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(500, { error: 'boom' }))));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe(true);
    expect(result.current.loaded).toBe(false);
    expect(result.current.items).toHaveLength(0);
  });

  it('a network error on first load is a failure too', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe(true);
  });

  it('no session (401) is an empty feed, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(401, { error: 'Unauthorized' }))));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe(false);
    expect(result.current.items).toHaveLength(0);
  });

  it('is not ready before the first read resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useNotifications());
    expect(result.current.ready).toBe(false);
    expect(result.current.error).toBe(false);
  });

  it('a failed focus refetch keeps the last good items and sets error', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { notifications: SIX })));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.items).toHaveLength(6));
    expect(result.current.error).toBe(false);

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(500, { error: 'boom' })));
    pastReloadWindow();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.items).toHaveLength(6);
    expect(result.current.unreadCount).toBe(6);
    expect(result.current.loaded).toBe(true);

    // The next good read clears the error.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { notifications: SIX })));
    await act(async () => {
      await result.current.reload({ force: true });
    });
    expect(result.current.error).toBe(false);
  });
});

describe('NotificationsBell failure states', () => {
  it('a first-load failure says so with Retry, never "No notifications yet."', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(500, { error: 'boom' })));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    const trigger = await screen.findByRole('button', { name: 'Notifications' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(trigger);
    expect(await screen.findByText('Notifications could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No notifications yet.')).toBeNull();
    expect(screen.queryByText(/0 unread/)).toBeNull();

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { notifications: SIX })));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('6 unread')).toBeInTheDocument();
    expect(screen.queryByText('Notifications could not be loaded.')).toBeNull();
  });

  it('a failed refetch after a good load keeps the "N unread" label and the items', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { notifications: SIX })));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationsBell />);
    await screen.findByRole('button', { name: 'Notifications, 6 unread' });

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(500, { error: 'boom' })));
    pastReloadWindow();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    const feedReads = () =>
      fetchMock.mock.calls.filter((call) => String((call as unknown[])[0]) === '/api/v1/notifications').length;
    await waitFor(() => expect(feedReads()).toBe(2));
    const trigger = screen.getByRole('button', { name: 'Notifications, 6 unread' });
    fireEvent.click(trigger);
    expect(screen.getByText('6 unread')).toBeInTheDocument();
    expect(screen.queryByText('Notifications could not be loaded.')).toBeNull();
  });
});

describe('useNotifications mark-read failure', () => {
  function feedThenPatch(patch: () => Promise<Response>) {
    return vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/notifications') {
        return Promise.resolve(jsonResponse(200, { notifications: SIX }));
      }
      return patch();
    });
  }

  it('a refused PATCH restores read_at and names the item', async () => {
    vi.stubGlobal('fetch', feedThenPatch(() => Promise.resolve(jsonResponse(500, { error: 'boom' }))));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(6));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.markRead('n0');
    });
    expect(ok).toBe(false);
    expect(result.current.items.find((n) => n.id === 'n0')?.read_at).toBeNull();
    expect(result.current.unreadCount).toBe(6);
    expect(result.current.markReadFailedId).toBe('n0');
  });

  it('a network error restores read_at too', async () => {
    vi.stubGlobal('fetch', feedThenPatch(() => Promise.reject(new TypeError('offline'))));
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(6));
    await act(async () => {
      await result.current.markRead('n1');
    });
    expect(result.current.unreadCount).toBe(6);
    expect(result.current.markReadFailedId).toBe('n1');
  });

  it('a later success clears the failure', async () => {
    let fail = true;
    vi.stubGlobal(
      'fetch',
      feedThenPatch(() => Promise.resolve(fail ? jsonResponse(500, {}) : jsonResponse(200, { notification: {} }))),
    );
    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.unreadCount).toBe(6));
    await act(async () => {
      await result.current.markRead('n2');
    });
    expect(result.current.markReadFailedId).toBe('n2');
    fail = false;
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.markRead('n2');
    });
    expect(ok).toBe(true);
    expect(result.current.markReadFailedId).toBeNull();
    expect(result.current.unreadCount).toBe(5);
  });
});
