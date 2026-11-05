'use client';

import * as React from 'react';

/** How often an open, visible rail re-reads who is on what. */
export const RAIL_POLL_MS = 30_000;

/** Focus and visibilitychange fire together when a tab comes back: one read. */
const COALESCE_MS = 2_000;

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Keeps a rail current while two people work it: calls `onRefresh` when the
 * tab regains focus or becomes visible, and every 30 seconds while it is
 * visible. A hidden tab never polls. No Realtime: presence over Supabase
 * channels needs per-deal authorization (handoff entry E5,
 * "Live presence and pushed updates on the rail").
 */
export function useRailFreshness(onRefresh: () => void, enabled: boolean): void {
  const latest = React.useRef(onRefresh);
  React.useEffect(() => {
    latest.current = onRefresh;
  }, [onRefresh]);

  React.useEffect(() => {
    if (!enabled) return;
    let last = 0;
    const run = (force: boolean) => {
      if (!visible()) return;
      const now = Date.now();
      if (!force && now - last < COALESCE_MS) return;
      last = now;
      latest.current();
    };
    const onReturn = () => run(false);
    const timer = window.setInterval(() => run(true), RAIL_POLL_MS);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [enabled]);
}
