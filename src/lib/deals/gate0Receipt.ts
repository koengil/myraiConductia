// Gate 0 create receipt hand-off (G20). The wizard creates the deal and then
// navigates to /projects/{code}/rail?new=1 — but router navigation can't carry
// the create response, and the CREATOR is not a notification recipient (the CCO
// is), so GET /notifications wouldn't surface it to them. So the wizard stashes
// a small, honest receipt in sessionStorage keyed by deal code; the rail landing
// reads it once (on ?new=1) and clears it.
//
// Honest by construction: it carries only what actually ran — the MNPI screen
// verdict and the notification count/timestamp. No KYC/FINRA claims.
//
// Stamped with the user who created the deal (`storeOwner`, #162): a take
// returns only the current owner's receipt and deletes any other one,
// unstamped legacy entries included. With no known owner a stash persists
// nothing and a take returns nothing and leaves the entry for when the owner
// is known (the shell's deal list installs the auth listener, so the owner is
// known by the time a banker completes the wizard).

import type { InviteChipState } from '@/components/wizard/inviteQueue';
import { storeOwner } from '@/lib/session/storeOwner';

const KEY_PREFIX = 'ib-gate0-receipt:';

export type Gate0Receipt = {
  /** MNPI screen verdict from screenMessage() over the notice text. */
  verdict: 'compliant' | 'hold' | 'blocked';
  /** How many recipients (tenant CCOs) were notified. */
  recipients: number;
  /** ISO timestamp of the notification (first recipient), if any. */
  at: string | null;
  /** Per-invitation delivery outcome for the email invites queued at Gate 0
   *  (platform_onboarding). Absent when nothing was queued. Delivery failures
   *  never fail the mandate; the retry path is the deal's Team. */
  invites?: Array<{ email: string; state: InviteChipState }>;
  /** Where the mandate came from. `discovery` when it was promoted from a proposed deal: the banner says so. */
  origin?: 'discovery';
};

function key(code: string): string {
  return `${KEY_PREFIX}${code}`;
}

export function stashGate0Receipt(code: string, receipt: Gate0Receipt): void {
  if (typeof window === 'undefined' || !code) return;
  const owner = storeOwner();
  if (owner === null) return;
  try {
    window.sessionStorage.setItem(key(code), JSON.stringify({ ...receipt, uid: owner }));
  } catch {
    // sessionStorage unavailable — the receipt is a nicety, not load-bearing.
  }
}

/** Read and CLEAR the receipt for a code (one-shot: it only shows once). */
export function takeGate0Receipt(code: string): Gate0Receipt | null {
  if (typeof window === 'undefined' || !code) return null;
  const owner = storeOwner();
  if (owner === null) return null;
  try {
    const raw = window.sessionStorage.getItem(key(code));
    if (!raw) return null;
    window.sessionStorage.removeItem(key(code));
    const { uid, ...receipt } = JSON.parse(raw) as Gate0Receipt & { uid?: unknown };
    // Another user's receipt, or an unstamped legacy one: dropped, never shown.
    return uid === owner ? receipt : null;
  } catch {
    return null;
  }
}

/** Remove every stashed receipt (sign-out, identity change), whatever its code or owner. */
export function clearGate0Receipts(): void {
  if (typeof window === 'undefined') return;
  const stale: string[] = [];
  for (let i = 0; i < window.sessionStorage.length; i += 1) {
    const k = window.sessionStorage.key(i);
    if (k?.startsWith(KEY_PREFIX)) stale.push(k);
  }
  for (const k of stale) window.sessionStorage.removeItem(k);
}
