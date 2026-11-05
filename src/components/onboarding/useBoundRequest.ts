'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * A request whose result is bound to the inputs that produced it.
 *
 * The failure this prevents: an inviter types an address, gets a seller
 * recommendation, changes the company, and the old recommendation stays on
 * screen describing a company nobody selected. They confirm what they see and
 * send a seat nobody chose.
 *
 * So a result is never "the latest response". It is the response for the
 * CURRENT key, and that is enforced by construction: the fetched entry carries
 * the key it was fetched for, and the hook compares it to the live key at
 * render time. A response for any other key cannot be returned, whatever order
 * it arrived in and whether or not its request was successfully aborted
 * (criteria A13, A14, B8).
 */
export type BoundStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'unavailable';

export type BoundRequest<TResult> = {
  status: BoundStatus;
  /** Present only while `status` is 'ready'. */
  result: TResult | null;
  /** The key the result belongs to, for callers that want to assert binding. */
  boundKey: string | null;
  refresh: () => void;
};

type Entry<TResult> = { key: string; result: TResult | null; failed: boolean };

export function useBoundRequest<TResult>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<TResult>,
): BoundRequest<TResult> {
  const [entry, setEntry] = useState<Entry<TResult> | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!key) return;

    // `cancelled` flips in cleanup, which React runs before the next effect
    // whenever the key changes. It is therefore exactly "this key is no longer
    // the current one" — no ref bookkeeping needed.
    let cancelled = false;
    const controller = new AbortController();

    fetcher(controller.signal)
      .then((value) => {
        if (!cancelled) setEntry({ key, result: value, failed: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setEntry({ key, result: null, failed: true });
      });

    return () => {
      cancelled = true;
      // Abort is an optimization: it saves the network round trip. The binding
      // guarantee does not depend on it landing.
      controller.abort();
    };
    // `fetcher` is deliberately excluded: callers define it inline, so it is a
    // new function every render, and `key` already encodes every bound input
    // it closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Derived at render, never stored. There is no frame in which a result for a
  // superseded key can be painted, because a mismatched entry is simply not
  // reachable through this return value.
  const matches = entry !== null && entry.key === key;

  if (key === null) {
    return { status: 'idle', result: null, boundKey: null, refresh };
  }
  if (matches) {
    return entry!.failed
      ? { status: 'unavailable', result: null, boundKey: null, refresh }
      : { status: 'ready', result: entry!.result, boundKey: entry!.key, refresh };
  }
  // An entry exists but for different inputs: the surface had something and is
  // now rechecking, which reads differently to a first load.
  return {
    status: entry === null ? 'loading' : 'stale',
    result: null,
    boundKey: null,
    refresh,
  };
}

/**
 * Builds a stable key from named inputs. Sorting means equal inputs always
 * produce an equal key regardless of the order they were written in.
 */
export function boundKeyOf(parts: Record<string, string | number | null | undefined>): string {
  const entries = Object.keys(parts)
    .sort()
    .map((name) => [name, parts[name] ?? null]);
  return JSON.stringify(entries);
}
