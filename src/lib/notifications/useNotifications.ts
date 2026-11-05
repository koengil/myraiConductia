'use client';

import { useSyncExternalStore } from 'react';

/**
 * useNotifications — the caller's notification feed (G17). Fetches
 * GET /api/v1/notifications and exposes the unread count + a mark-read action
 * (PATCH). No session (401, e.g. the fixture demo) is an empty feed. Any other
 * failure is a failure, never an empty desk: `error` is set, and the
 * last good `items` stay on screen (`loaded` says whether there are any).
 * Optimistic mark-read.
 *
 * One feed per tab: the bell and every nav count badge read the same store, so
 * marking a notification read anywhere clears it everywhere, and mounting ten
 * readers still makes one request. No polling, no realtime; the refresh model
 * itself is handoff entry E13, "Notifications refresh model".
 *
 * Freshness (#173 G-04): the feed loads when the first reader mounts, again
 * when the tab regains focus or becomes visible (at most once every
 * VISIBILITY_RELOAD_MIN_MS), and whenever a consumer calls
 * reload({ force: true }) (the bell does, on open). Loads are single-flight,
 * only the newest response is applied, and an item marked read here stays read
 * even if an older response that still has it unread lands afterwards.
 */

/** A focus or visibility reload is skipped when the last load, successful or not, started less than this ago. */
export const VISIBILITY_RELOAD_MIN_MS = 30_000;

export type AppNotification = {
  id: string;
  deal_id: string | null;
  event_type: string;
  payload: {
    code?: string;
    codename?: string;
    actor?: string;
    /** mailbox_connected, team_mailbox_refused: the mailbox address. */
    address?: string;
    screening?: { verdict?: string };
  } & Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

/**
 * Fetch the caller's notifications. No session (401) is an empty feed; any
 * other non-OK answer or a network error rejects, so a failed read is never
 * mistaken for "nothing needs you".
 */
async function fetchNotifications(): Promise<AppNotification[]> {
  const res = await fetch('/api/v1/notifications', {
    credentials: 'include',
    // User-scoped and never cacheable: no-store keeps identical concurrent reads out of Chromium's HTTP cache lock (#162).
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (res.status === 401) return [];
  if (!res.ok) throw new Error(`notifications: ${res.status}`);
  const body = (await res.json()) as { notifications?: AppNotification[] };
  return Array.isArray(body.notifications) ? body.notifications : [];
}

type Snapshot = {
  items: AppNotification[];
  /** A read has settled (succeeded or failed). */
  ready: boolean;
  /** The latest read failed. `items` are the last good ones, if any. */
  error: boolean;
  /** A read has succeeded, so `items` are real. */
  loaded: boolean;
  /** The last item whose mark-read the server refused, else null. */
  markReadFailedId: string | null;
};

const EMPTY: Snapshot = { items: [], ready: false, error: false, loaded: false, markReadFailedId: null };

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
// Bumped when the last reader unmounts, so a read started for an earlier
// session of readers never lands on a later one.
let generation = 0;
// When a load last started (0: never), whether it then succeeded or failed, for the focus/visibility throttle.
let lastAttemptAt = 0;
// Ids marked read here that no loaded list has shown read yet, with the read_at shown for them.
const readLocally = new Map<string, string>();

function emit(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

/**
 * Read the feed; concurrent callers share the request in flight. Without
 * `force`, a read is skipped within VISIBILITY_RELOAD_MIN_MS of the last one.
 */
function refresh(opts: { force?: boolean } = {}): Promise<void> {
  if (inflight) return inflight;
  if (!opts.force && Date.now() - lastAttemptAt < VISIBILITY_RELOAD_MIN_MS) return Promise.resolve();
  // Counted at the start, so a failing feed is not asked again on every tab switch.
  lastAttemptAt = Date.now();
  const started = generation;
  const read: Promise<void> = fetchNotifications()
    .then(
      (list) => {
        if (started !== generation) return;
        const items = list.map((n) => {
          const localReadAt = readLocally.get(n.id);
          return !n.read_at && localReadAt ? { ...n, read_at: localReadAt } : n;
        });
        for (const n of list) if (n.read_at) readLocally.delete(n.id);
        emit({ ...snapshot, items, ready: true, error: false, loaded: true });
      },
      () => {
        // Keep the last good items: a failed refetch never wipes the desk.
        if (started === generation) emit({ ...snapshot, ready: true, error: true });
      },
    )
    .finally(() => {
      // Only this read's own slot: a remount may have started a newer one.
      if (inflight === read) inflight = null;
    });
  inflight = read;
  return read;
}

function onFocus() {
  void refresh();
}

function onVisibility() {
  // The tab coming back (any state but hidden, as useCurrentUser reads it) reloads, throttled.
  if (document.visibilityState !== 'hidden') void refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    void refresh({ force: true });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      // A response that lands after the last reader unmounts is dropped, and a remount starts its own load.
      generation += 1;
      inflight = null;
      lastAttemptAt = 0;
      readLocally.clear();
      snapshot = EMPTY;
    }
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => EMPTY;

/**
 * Mark one notification read. Optimistic: read_at flips locally first, and is
 * remembered so a load already in flight cannot bring the item back unread. A
 * refused PATCH or a network error puts the item's read_at back and records
 * it in `markReadFailedId`, so the item never looks cleared when the
 * server kept it unread; the next load then shows what the server holds.
 * Resolves true when the server took it.
 */
async function markNotificationRead(id: string): Promise<boolean> {
  const started = generation;
  const previous = snapshot.items.find((n) => n.id === id)?.read_at ?? null;
  const optimistic = previous ?? new Date().toISOString();
  if (!previous) readLocally.set(id, optimistic);
  emit({
    ...snapshot,
    markReadFailedId: snapshot.markReadFailedId === id ? null : snapshot.markReadFailedId,
    items: snapshot.items.map((n) => (n.id === id ? { ...n, read_at: optimistic } : n)),
  });
  let ok = false;
  try {
    const res = await fetch(`/api/v1/notifications/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ read: true }),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  // A read for an earlier session of readers never lands on a later one.
  if (started !== generation) return ok;
  if (ok) {
    if (snapshot.markReadFailedId === id) emit({ ...snapshot, markReadFailedId: null });
    return true;
  }
  // Not saved: forget the local mark, so the next load shows what the server holds.
  if (readLocally.get(id) === optimistic) readLocally.delete(id);
  emit({
    ...snapshot,
    markReadFailedId: id,
    // Only undo our own flip: a refetch may have landed the server's value.
    items: snapshot.items.map((n) => (n.id === id && n.read_at === optimistic ? { ...n, read_at: previous } : n)),
  });
  return false;
}

export function useNotifications() {
  const { items, ready, error, loaded, markReadFailedId } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const unreadCount = items.reduce((n, x) => (x.read_at ? n : n + 1), 0);
  // Module-level functions: stable across renders without useCallback.
  return {
    items,
    unreadCount,
    ready,
    error,
    loaded,
    markReadFailedId,
    reload: refresh,
    markRead: markNotificationRead,
  };
}
