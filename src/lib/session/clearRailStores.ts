import { clearGate0Receipts } from '@/lib/deals/gate0Receipt';
import { clearRailRunStates } from '@/components/rail/railRunState';

/**
 * The rail state this browser persists per deal code (#162): run receipts and
 * versions (localStorage `ib-rail-run:*`) and the one-shot Gate 0 create
 * receipt (sessionStorage `ib-gate0-receipt:*`). Each entry is stamped with its
 * owner and only read back by that owner (`storeOwner`); every owner's entries
 * are also cleared on sign-out (clearLocalStores) and, by the shared-read auth
 * listener, on any identity change.
 *
 * Its own module so the auth listener (src/lib/api/inflightRead.ts) depends on
 * these two stores only, not on everything clearLocalStores reaches.
 *
 * Not here, on purpose: `rail-template-save:<actor>:<deal>` and
 * `rail-template-create:<actor>` are already keyed by the signed-in user, and
 * `ib-rail-collapsed` is the shell's collapse preference, not deal state.
 */
export const RAIL_CLEARS: ReadonlyArray<() => void> = [clearRailRunStates, clearGate0Receipts];

/** Runs each clear in the browser; a failing store never stops the others. */
export function runEach(clears: ReadonlyArray<() => void>): void {
  if (typeof window === 'undefined') return;
  for (const clear of clears) {
    try {
      clear();
    } catch {
      continue;
    }
  }
}

/** Every rail store above. */
export function clearRailStores(): void {
  runEach(RAIL_CLEARS);
}
