'use client';

import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { DEALS_EVENT, DEALS_STORE_KEY } from '@/lib/rail/deals';
import { clearRailStores } from '@/lib/session/clearRailStores';
import { LOCAL_STORE_OWNER, setStoreOwner, storeOwner } from '@/lib/session/storeOwner';

/**
 * inflightRead: one shared request per read key while it is in flight (#162).
 *
 * Every `useDeals` and `useProjectRail` instance that mounts in the same wave
 * joins one request instead of issuing its own. Chromium's HTTP cache lock
 * releases identical concurrent GETs one at a time, so six identical
 * `/api/v1/deals` reads used to queue behind each other for seconds.
 *
 * Only the request is shared. Nothing is cached after it settles: the entry is
 * deleted on settle, and the next mount after that starts a fresh read. Each
 * hook keeps its own state, flag-driven source and fallback.
 *
 * Freshness comes from generations, not aborts. A generation is the sum of
 * three monotonic counters (global + family + per key). Bumping one detaches
 * the matching live entries without aborting them: existing joiners still
 * settle, and consumers drop any result, success or rejection, whose
 * generation is older than the current one. Aborts are reserved for a real
 * identity change (`abortAllReads`) and for the read's deadline.
 *
 * Every shared read is bounded. The deadline belongs to the shared entry, not
 * to each caller: a late joiner gets the entry's remaining time, so one
 * request has one budget. At the deadline the entry aborts its signal and
 * every joiner rejects with a `ReadTimeoutError`, even when the underlying
 * `fetch` ignores the signal.
 */

export type ReadKey = 'deals' | `rail:${string}` | `step-records:${string}`;
export type ReadFamily = 'deals' | 'rail:*' | 'step-records:*';

type FamilyName = 'deals' | 'rail' | 'step-records';

export type SharedReadResult<T> = { generation: number; value: T };

/** A shared read that outlived its deadline. */
export class ReadTimeoutError extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`shared read exceeded its ${deadlineMs} ms deadline`);
    this.name = 'ReadTimeoutError';
    this.deadlineMs = deadlineMs;
  }
}

/** A shared read that failed or was aborted, stamped with the generation it ran under. */
export class SharedReadError extends Error {
  readonly generation: number;
  readonly reason: unknown;
  readonly aborted: boolean;

  constructor(generation: number, reason: unknown, aborted: boolean) {
    super(aborted ? 'shared read aborted' : 'shared read failed');
    this.name = 'SharedReadError';
    this.generation = generation;
    this.reason = reason;
    this.aborted = aborted;
  }

  /** True when the read was cut by its deadline (not a failure, not an identity abort). */
  get timedOut(): boolean {
    return this.reason instanceof ReadTimeoutError;
  }
}

/** True when `error` is a shared read that hit its deadline. */
export function isReadTimeout(error: unknown): boolean {
  return error instanceof SharedReadError && error.timedOut;
}

export type SharedReadOptions = {
  /** The entry's whole budget, from the moment the read starts. */
  deadlineMs: number;
};

type LiveEntry = {
  generation: number;
  controller: AbortController;
  promise: Promise<SharedReadResult<unknown>>;
};

let globalGeneration = 0;
const familyGeneration: Record<FamilyName, number> = {
  deals: 0,
  rail: 0,
  'step-records': 0,
};
const keyGeneration = new Map<ReadKey, number>();
const live = new Map<ReadKey, LiveEntry>();
const listeners = new Set<() => void>();

function familyOf(key: ReadKey): FamilyName {
  if (key === 'deals') return 'deals';
  if (key.startsWith('rail:')) return 'rail';
  return 'step-records';
}

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

/**
 * The identity generation: it moves only on `abortAllReads` (sign-out, an
 * identity change). State a surface keeps outside these reads (the rail's
 * local completion and skip overrides) keys on it, so nothing one user did
 * locally renders for the next. Subscribe with `subscribeGeneration`.
 */
export function identityGeneration(): number {
  return globalGeneration;
}

export function readGeneration(key: ReadKey): number {
  return globalGeneration + familyGeneration[familyOf(key)] + (keyGeneration.get(key) ?? 0);
}

/** True when a result stamped with `generation` still belongs to `key`'s current generation. */
export function isCurrentGeneration(key: ReadKey, generation: number): boolean {
  return readGeneration(key) === generation;
}

/** The generation a shared read's rejection carries, or null for a foreign error. */
export function generationOfError(error: unknown): number | null {
  return error instanceof SharedReadError ? error.generation : null;
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Join the live read for `key` at its current generation, or start one.
 * Resolves with the value and the generation it ran under; rejects with a
 * `SharedReadError` carrying that generation. The entry is removed on settle.
 *
 * `deadlineMs` bounds the entry: a joiner inherits the remaining time and
 * never extends it. The timeout rejection belongs to the entry's generation,
 * so a current consumer receives it (`isReadTimeout`).
 */
export function sharedRead<T>(
  key: ReadKey,
  read: (signal: AbortSignal) => Promise<T>,
  opts: SharedReadOptions,
): Promise<SharedReadResult<T>> {
  const generation = readGeneration(key);
  const existing = live.get(key);
  if (existing && existing.generation === generation) {
    return existing.promise as Promise<SharedReadResult<T>>;
  }

  const controller = new AbortController();
  const { signal } = controller;
  // setTimeout, not AbortSignal.timeout: fake timers drive it in tests, and
  // the race below rejects even when the read ignores its signal.
  const timer = setTimeout(
    () => controller.abort(new ReadTimeoutError(opts.deadlineMs)),
    opts.deadlineMs,
  );
  let started: Promise<T>;
  try {
    started = read(signal);
  } catch (error) {
    started = Promise.reject(error);
  }
  const promise: Promise<SharedReadResult<T>> = Promise.race([started, abortRejection(signal)]).then(
    (value) => ({ generation, value }),
    (reason: unknown) => {
      // Once aborted, the signal's reason is the cause (a deadline or an
      // identity change), whichever of the two racers settled first.
      const cause = signal.aborted ? (signal.reason ?? reason) : reason;
      throw new SharedReadError(generation, cause, signal.aborted);
    },
  );
  const entry: LiveEntry = {
    generation,
    controller,
    promise: promise as Promise<SharedReadResult<unknown>>,
  };
  live.set(key, entry);

  const settle = () => {
    clearTimeout(timer);
    if (live.get(key) === entry) live.delete(key);
  };
  promise.then(settle, settle);
  return promise;
}

function matches(key: ReadKey, target: ReadKey | ReadFamily): boolean {
  if (target === 'rail:*') return familyOf(key) === 'rail';
  if (target === 'step-records:*') return familyOf(key) === 'step-records';
  return key === target;
}

/**
 * Move `target` to a new generation. Live entries for it are detached, not
 * aborted; subscribers re-render (stale state presents as loading) and re-join
 * one fresh read.
 */
export function bumpGeneration(target: ReadKey | ReadFamily): void {
  if (target === 'deals') familyGeneration.deals += 1;
  else if (target === 'rail:*') familyGeneration.rail += 1;
  else if (target === 'step-records:*') familyGeneration['step-records'] += 1;
  else keyGeneration.set(target, (keyGeneration.get(target) ?? 0) + 1);

  for (const key of Array.from(live.keys())) {
    if (matches(key, target)) live.delete(key);
  }
  notify();
}

/**
 * Identity change: move every key to a new generation AND abort every live
 * read, so nothing started as one user is delivered to the next. The aborted
 * reads reject with their old generation, which consumers drop as stale.
 */
export function abortAllReads(): void {
  globalGeneration += 1;
  const entries = Array.from(live.values());
  live.clear();
  for (const entry of entries) entry.controller.abort();
  notify();
}

// ---------------------------------------------------------------------------
// Module listeners. They install from the first subscribeGeneration call,
// which every useDeals / useProjectRail instance makes through
// useSyncExternalStore; the auth listener retries on later calls until a
// browser client exists. They therefore also run in fixture and flag-off mode,
// where sharedRead is never called.

let listenersInstalled = false;
let authListenerInstalled = false;
let authInstallFailureLogged = false;
let lastUserId: string | null | undefined;

type AuthSession = { user?: { id?: string | null } | null } | null;

function onAuthChange(event: string, session: AuthSession): void {
  // Synchronous on purpose: awaiting a Supabase call inside this callback is
  // the init-deadlock shape fixed upstream in supabase-js #2498.
  const nextUserId = session?.user?.id ?? null;
  if (event === 'SIGNED_OUT') {
    // Nobody owns the per-user stores now, and the rail run state this
    // browser kept for the signed-out user goes too, before the generation
    // moves, so a re-render never reads it back.
    setStoreOwner(null);
    clearRailStores();
    abortAllReads();
    lastUserId = null;
    return;
  }
  if (lastUserId === undefined) {
    // First event this document has seen (INITIAL_SESSION, or an init-time
    // refresh that beat it): it seeds the identity the page loaded under.
    // The stores are stamped per owner, so nothing is cleared here: a reader
    // only returns this user's entries. Subscribers re-read the owner.
    lastUserId = nextUserId;
    setStoreOwner(nextUserId);
    notify();
    return;
  }
  if (nextUserId !== lastUserId) {
    setStoreOwner(nextUserId);
    clearRailStores();
    abortAllReads();
    lastUserId = nextUserId;
  }
  // Same-user re-emits (SIGNED_IN on tab refocus, USER_UPDATED,
  // TOKEN_REFRESHED) change nothing.
}

function installAuthListener(): void {
  if (authListenerInstalled) return;
  try {
    const client = createSupabaseBrowserClient();
    client.auth.onAuthStateChange((event, session) => {
      onAuthChange(event, session);
    });
    authListenerInstalled = true;
    // An auth client exists after all: the owner comes from its events.
    if (storeOwner() === LOCAL_STORE_OWNER) setStoreOwner(null);
  } catch (error) {
    // No browser client yet (missing env, test mock without auth): skip the
    // subscription for now and try again on the next subscribeGeneration
    // call. A missing client never fails a read. Until an auth event says
    // otherwise, the per-user stores belong to the single local actor.
    if (lastUserId === undefined && storeOwner() === null) setStoreOwner(LOCAL_STORE_OWNER);
    if (!authInstallFailureLogged && process.env.NODE_ENV !== 'test') {
      authInstallFailureLogged = true;
      console.warn('inflightRead: auth listener not installed yet; retrying on the next subscribe', error);
    }
  }
}

function installModuleListeners(): void {
  if (typeof window === 'undefined') return;
  // The auth listener retries until it installs; the window listeners
  // install exactly once.
  installAuthListener();
  if (listenersInstalled) return;
  listenersInstalled = true;

  // A created deal (fixture or API) dispatches DEALS_EVENT: one bump per
  // event, so every mounted instance re-joins one fresh read.
  window.addEventListener(DEALS_EVENT, () => bumpGeneration('deals'));
  // Another tab changed the fixture deal store, or cleared storage. Any other
  // key (ib-rail-collapsed, drafts, ...) is not a deal-list change.
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === DEALS_STORE_KEY || event.key === null) bumpGeneration('deals');
  });
}

/** For useSyncExternalStore. The first call installs the module listeners. */
export function subscribeGeneration(listener: () => void): () => void {
  installModuleListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
