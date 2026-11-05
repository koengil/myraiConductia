import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The coordinator is module state: every test gets a fresh copy.
type Module = typeof import('@/lib/api/inflightRead');

const supabaseMock = vi.hoisted(() => ({
  throwOnCreate: false,
  onAuthStateChange: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  createSupabaseBrowserClient: () => {
    if (supabaseMock.throwOnCreate) throw new Error('Supabase is not configured');
    return { auth: { onAuthStateChange: supabaseMock.onAuthStateChange } };
  },
}));

// A deadline far past any test's lifetime; the deadline tests set their own.
const OPTS = { deadlineMs: 60_000 };

async function load(): Promise<Module> {
  vi.resetModules();
  return import('@/lib/api/inflightRead');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  supabaseMock.throwOnCreate = false;
  supabaseMock.onAuthStateChange = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sharedRead', () => {
  it('joins the live read while it is pending', async () => {
    const m = await load();
    const d = deferred<string>();
    const read = vi.fn(() => d.promise);

    const a = m.sharedRead('deals', read, OPTS);
    const b = m.sharedRead('deals', read, OPTS);
    expect(read).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);

    d.resolve('list');
    await expect(a).resolves.toEqual({ generation: m.readGeneration('deals'), value: 'list' });
  });

  it('starts a fresh read after the previous one settles: nothing is cached', async () => {
    const m = await load();
    const read = vi.fn(async () => 'list');

    await m.sharedRead('deals', read, OPTS);
    await m.sharedRead('deals', read, OPTS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps no entry after a rejection either', async () => {
    const m = await load();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce('list');

    await expect(m.sharedRead('deals', read, OPTS)).rejects.toMatchObject({
      name: 'SharedReadError',
      generation: m.readGeneration('deals'),
      aborted: false,
    });
    await expect(m.sharedRead('deals', read, OPTS)).resolves.toMatchObject({ value: 'list' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keys reads separately: deals and two rails are three requests', async () => {
    const m = await load();
    const read = vi.fn(() => new Promise<string>(() => {}));
    m.sharedRead('deals', read, OPTS);
    m.sharedRead('rail:a', read, OPTS);
    m.sharedRead('rail:b', read, OPTS);
    m.sharedRead('rail:a', read, OPTS);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('bumpGeneration', () => {
  it('detaches the live read without rejecting its existing joiners', async () => {
    const m = await load();
    const first = deferred<string>();
    const second = deferred<string>();
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const before = m.readGeneration('deals');
    const old = m.sharedRead('deals', read, OPTS);
    m.bumpGeneration('deals');
    const fresh = m.sharedRead('deals', read, OPTS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0][0].aborted).toBe(false);

    first.resolve('old list');
    second.resolve('new list');
    const oldResult = await old;
    const freshResult = await fresh;

    // The detached read still settles, stamped with its own generation, which
    // a consumer reports as stale.
    expect(oldResult).toEqual({ generation: before, value: 'old list' });
    expect(m.isCurrentGeneration('deals', oldResult.generation)).toBe(false);
    expect(m.isCurrentGeneration('deals', freshResult.generation)).toBe(true);
  });

  it('reports a stale-generation rejection as stale', async () => {
    const m = await load();
    const d = deferred<string>();
    const old = m.sharedRead('deals', () => d.promise, OPTS);
    m.bumpGeneration('deals');
    d.reject(new Error('500'));

    const error = await old.catch((e: unknown) => e);
    const generation = m.generationOfError(error);
    expect(generation).not.toBeNull();
    expect(m.isCurrentGeneration('deals', generation!)).toBe(false);
  });

  it('"rail:*" bumps rail:a and a not-yet-read rail:b, but not deals', async () => {
    const m = await load();
    const deals = m.readGeneration('deals');
    const railA = m.readGeneration('rail:a');
    const railB = m.readGeneration('rail:b');

    m.bumpGeneration('rail:*');

    expect(m.readGeneration('rail:a')).toBe(railA + 1);
    expect(m.readGeneration('rail:b')).toBe(railB + 1);
    expect(m.readGeneration('deals')).toBe(deals);
    expect(m.readGeneration('step-records:a')).toBe(0);
  });

  it('a per-key bump moves only that key', async () => {
    const m = await load();
    m.bumpGeneration('rail:a');
    expect(m.readGeneration('rail:a')).toBe(1);
    expect(m.readGeneration('rail:b')).toBe(0);
    expect(m.readGeneration('deals')).toBe(0);
  });

  it('notifies subscribers synchronously', async () => {
    const m = await load();
    const listener = vi.fn();
    m.subscribeGeneration(listener);
    m.bumpGeneration('deals');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('abortAllReads', () => {
  it('aborts every live read and rejects its joiners as stale, even when the read ignores the signal', async () => {
    const m = await load();
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>(() => new Promise<string>(() => {}));

    const deals = m.sharedRead('deals', read, OPTS);
    const rail = m.sharedRead('rail:a', read, OPTS);
    m.abortAllReads();

    for (const p of [deals, rail]) {
      const error = await p.catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'SharedReadError', aborted: true });
      expect(m.isCurrentGeneration('deals', m.generationOfError(error)!)).toBe(false);
    }
    expect(read.mock.calls.every(([signal]) => signal.aborted)).toBe(true);
    // Every key moved: the next read is a fresh request.
    m.sharedRead('deals', read, OPTS);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('module listeners', () => {
  it('install once, from subscribeGeneration, without any sharedRead call', async () => {
    const m = await load();
    const add = vi.spyOn(window, 'addEventListener');

    const off1 = m.subscribeGeneration(() => {});
    const off2 = m.subscribeGeneration(() => {});
    off1();
    off2();
    m.subscribeGeneration(() => {});

    const types = add.mock.calls.map(([type]) => type);
    expect(types.filter((t) => t === 'ib:deals')).toHaveLength(1);
    expect(types.filter((t) => t === 'storage')).toHaveLength(1);
    expect(supabaseMock.onAuthStateChange).toHaveBeenCalledTimes(1);

    const before = m.readGeneration('deals');
    window.dispatchEvent(new Event('ib:deals'));
    expect(m.readGeneration('deals')).toBe(before + 1);
  });

  it('bumps deals on storage events for the fixture store key or a clear, never for another key', async () => {
    const m = await load();
    m.subscribeGeneration(() => {});
    const start = m.readGeneration('deals');

    window.dispatchEvent(new StorageEvent('storage', { key: 'ib-rail-collapsed' }));
    expect(m.readGeneration('deals')).toBe(start);
    window.dispatchEvent(new StorageEvent('storage', { key: 'ib-fixture-deals' }));
    expect(m.readGeneration('deals')).toBe(start + 1);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(m.readGeneration('deals')).toBe(start + 2);
  });

  it('skips the auth subscription when the browser client throws, and reads still succeed', async () => {
    supabaseMock.throwOnCreate = true;
    const m = await load();

    expect(() => m.subscribeGeneration(() => {})).not.toThrow();
    expect(supabaseMock.onAuthStateChange).not.toHaveBeenCalled();
    await expect(m.sharedRead('deals', async () => 'list', OPTS)).resolves.toMatchObject({
      value: 'list',
    });
  });

  it('retries the auth subscription on a later subscribe once a client exists, and installs it once', async () => {
    supabaseMock.throwOnCreate = true;
    const m = await load();
    const add = vi.spyOn(window, 'addEventListener');

    m.subscribeGeneration(() => {});
    m.subscribeGeneration(() => {});
    expect(supabaseMock.onAuthStateChange).not.toHaveBeenCalled();
    await expect(m.sharedRead('deals', async () => 'list', OPTS)).resolves.toMatchObject({
      value: 'list',
    });

    supabaseMock.throwOnCreate = false;
    m.subscribeGeneration(() => {});
    m.subscribeGeneration(() => {});
    expect(supabaseMock.onAuthStateChange).toHaveBeenCalledTimes(1);

    // The window listeners never re-install on the retries.
    const types = add.mock.calls.map(([type]) => type);
    expect(types.filter((t) => t === 'ib:deals')).toHaveLength(1);
    expect(types.filter((t) => t === 'storage')).toHaveLength(1);

    // The late subscription is live: an identity change aborts.
    const callback = supabaseMock.onAuthStateChange.mock.calls[0][0] as (
      event: string,
      session: { user: { id: string } } | null,
    ) => void;
    callback('INITIAL_SESSION', { user: { id: 'a' } });
    const seeded = m.readGeneration('deals');
    callback('SIGNED_OUT', null);
    expect(m.readGeneration('deals')).toBe(seeded + 1);
  });

  it('tracks the per-user store owner: unknown until the first event, then the session user, null after sign-out', async () => {
    const m = await load();
    const { storeOwner } = await import('@/lib/session/storeOwner');
    const notified = vi.fn();
    m.subscribeGeneration(notified);
    const callback = supabaseMock.onAuthStateChange.mock.calls[0][0] as (
      event: string,
      session: { user: { id: string } } | null,
    ) => void;
    expect(storeOwner()).toBeNull();

    // The first event only seeds the identity, but subscribers re-read the owner.
    const gen = m.readGeneration('deals');
    callback('INITIAL_SESSION', { user: { id: 'b' } });
    expect(storeOwner()).toBe('b');
    expect(notified).toHaveBeenCalled();
    expect(m.readGeneration('deals')).toBe(gen);

    callback('SIGNED_IN', { user: { id: 'c' } });
    expect(storeOwner()).toBe('c');
    callback('SIGNED_OUT', null);
    expect(storeOwner()).toBeNull();
  });

  it('with no auth client the single local actor owns the stores, until a client installs', async () => {
    supabaseMock.throwOnCreate = true;
    const m = await load();
    const { LOCAL_STORE_OWNER, storeOwner } = await import('@/lib/session/storeOwner');
    m.subscribeGeneration(() => {});
    expect(storeOwner()).toBe(LOCAL_STORE_OWNER);

    supabaseMock.throwOnCreate = false;
    m.subscribeGeneration(() => {});
    expect(storeOwner()).toBeNull();
  });

  it('an identity change clears the persisted rail stores; a same-user re-emit does not', async () => {
    const m = await load();
    m.subscribeGeneration(() => {});
    const callback = supabaseMock.onAuthStateChange.mock.calls[0][0] as (
      event: string,
      session: { user: { id: string } } | null,
    ) => void;
    const RUN = 'ib-rail-run:project-summit';
    const RECEIPT = 'ib-gate0-receipt:MESAX-2026-462';
    const seed = () => {
      window.localStorage.setItem(RUN, '{"receipts":{},"versions":{}}');
      window.sessionStorage.setItem(RECEIPT, '{}');
    };

    callback('INITIAL_SESSION', { user: { id: 'a' } });
    seed();
    callback('TOKEN_REFRESHED', { user: { id: 'a' } });
    expect(window.localStorage.getItem(RUN)).not.toBeNull();

    callback('SIGNED_IN', { user: { id: 'b' } });
    expect(window.localStorage.getItem(RUN)).toBeNull();
    expect(window.sessionStorage.getItem(RECEIPT)).toBeNull();

    seed();
    callback('SIGNED_OUT', null);
    expect(window.localStorage.getItem(RUN)).toBeNull();
    expect(window.sessionStorage.getItem(RECEIPT)).toBeNull();
  });

  it('aborts on a real identity change only', async () => {
    const m = await load();
    m.subscribeGeneration(() => {});
    const callback = supabaseMock.onAuthStateChange.mock.calls[0][0] as (
      event: string,
      session: { user: { id: string } } | null,
    ) => void;
    const asUser = (id: string) => ({ user: { id } });
    const gen = () => m.readGeneration('deals');

    callback('INITIAL_SESSION', asUser('a'));
    const seeded = gen();
    callback('SIGNED_IN', asUser('a'));
    callback('USER_UPDATED', asUser('a'));
    callback('TOKEN_REFRESHED', asUser('a'));
    expect(gen()).toBe(seeded);

    callback('SIGNED_IN', asUser('b'));
    expect(gen()).toBe(seeded + 1);
    callback('SIGNED_OUT', null);
    expect(gen()).toBe(seeded + 2);
    callback('SIGNED_IN', asUser('b'));
    expect(gen()).toBe(seeded + 3);
  });
});

describe('deadline (#162 Phase 3)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects every joiner with ReadTimeoutError at the deadline, even when the read ignores its signal', async () => {
    vi.useFakeTimers();
    const m = await load();
    // Ignores the signal on purpose: the race in sharedRead still settles it.
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>(() => new Promise<string>(() => {}));

    const a = m.sharedRead('deals', read, { deadlineMs: 1000 });
    const b = m.sharedRead('deals', read, { deadlineMs: 1000 });
    const settled = Promise.allSettled([a, b]);

    await vi.advanceTimersByTimeAsync(999);
    expect(read.mock.calls[0][0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const results = await settled;
    for (const result of results) {
      expect(result.status).toBe('rejected');
      const error = (result as PromiseRejectedResult).reason;
      expect(m.isReadTimeout(error)).toBe(true);
      expect((error as InstanceType<typeof m.SharedReadError>).reason).toBeInstanceOf(
        m.ReadTimeoutError,
      );
      // The timeout belongs to the current generation: a consumer receives it.
      expect(m.isCurrentGeneration('deals', m.generationOfError(error)!)).toBe(true);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    // No entry survives: the next read is a fresh request.
    m.sharedRead('deals', read, { deadlineMs: 1000 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a failure that is not the deadline is not a timeout', async () => {
    const m = await load();
    const error = await m
      .sharedRead('deals', async () => Promise.reject(new Error('500')), { deadlineMs: 1000 })
      .catch((e: unknown) => e);
    expect(m.isReadTimeout(error)).toBe(false);
    expect(m.generationOfError(error)).not.toBeNull();
  });

  it('an identity abort is not a timeout', async () => {
    const m = await load();
    const p = m.sharedRead('deals', () => new Promise<string>(() => {}), { deadlineMs: 1000 });
    m.abortAllReads();
    const error = await p.catch((e: unknown) => e);
    expect(m.isReadTimeout(error)).toBe(false);
    expect(error).toMatchObject({ aborted: true });
  });

  it('clears the timer when the read settles first', async () => {
    vi.useFakeTimers();
    const m = await load();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const d = deferred<string>();
    const p = m.sharedRead('deals', () => d.promise, { deadlineMs: 1000 });

    d.resolve('list');
    await expect(p).resolves.toMatchObject({ value: 'list' });
    expect(clear).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a joiner added at deadline - 1 rejects at the deadline: one budget, never extended', async () => {
    vi.useFakeTimers();
    const m = await load();
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>(() => new Promise<string>(() => {}));

    const first = m.sharedRead('deals', read, { deadlineMs: 1000 });
    first.catch(() => {});
    await vi.advanceTimersByTimeAsync(999);
    // A late joiner asks for a full budget of its own; it does not get one.
    const late = m.sharedRead('deals', read, { deadlineMs: 1000 });
    expect(late).toBe(first);
    const lateOutcome = late.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1);
    expect(m.isReadTimeout(await lateOutcome)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
