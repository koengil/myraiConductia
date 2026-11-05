// Per-deal run state for the rail surface: receipts (every run collapses to a
// receipt line on its step), logged skips, and versioned outputs.
// Persisted in localStorage per deal, mirrored live via a window event — the
// same pattern deals.ts uses for token allocation. This is UI-local vision
// state; the real swap is the audit_log / documents tables (ADR-0008).
//
// Each entry is stamped with the user who wrote it (`storeOwner`, #162). A
// read returns only the current owner's entry and deletes any other one,
// unstamped legacy entries included; with no known owner a read returns
// nothing and a write persists nothing.

import type { ComplianceCheckResult, ComplianceStatus } from '@/lib/api/types';
import { storeOwner } from '@/lib/session/storeOwner';

export type ReceiptVerdict = 'clear' | 'hold' | 'blocked';

/** A collapsed run record on a step: "Screened · 12s ›", expandable. */
export type StepReceipt = {
  id: string;
  label: string;
  verdict: ReceiptVerdict;
  /** What was checked, receipt grammar: "KYC ✓" / "FINRA ✓" / reasons. */
  checks: string[];
  seconds: number;
  tokens?: number;
  at: string;
};

/** One entry in a step's versioned outputs list (Teaser V1 / V2 pattern). */
export type StepVersion = {
  version: number;
  label: string;
  note?: string;
  at: string;
};

export type RailRunState = {
  receipts: Record<string, StepReceipt[]>;
  versions: Record<string, StepVersion[]>;
};

export const RAIL_RUN_EVENT = 'ib:rail-run';

const EMPTY: RailRunState = { receipts: {}, versions: {} };

const KEY_PREFIX = 'ib-rail-run:';
const key = (dealId: string) => `${KEY_PREFIX}${dealId}`;

/** The persisted shape: the run state plus the owner that wrote it. */
type StoredRunState = Partial<RailRunState> & { uid?: unknown };

/**
 * Remove every deal's run state, whoever owns it (sign-out, identity change).
 * Reads already ignore other owners' entries; this also drops them (#162).
 */
export function clearRailRunStates(): void {
  if (typeof window === 'undefined') return;
  const stale: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(KEY_PREFIX)) stale.push(k);
  }
  if (stale.length === 0) return;
  for (const k of stale) window.localStorage.removeItem(k);
  window.dispatchEvent(new Event(RAIL_RUN_EVENT));
}

/**
 * Fixture versions — the Teaser V1/V2 pattern on the seeded sandbox deal, so
 * the versioned-outputs surface is visible before any run happens. Merged at
 * read time; stored versions append after them.
 */
const FIXTURE_VERSIONS: Record<string, Record<string, StepVersion[]>> = {
  'project-summit': {
    'p2-s36': [
      {
        version: 1,
        label: 'Teaser V1',
        note: 'Agent draft from approved deal data. Screened clear.',
        at: '2026-07-06T09:12:00.000Z',
      },
      {
        version: 2,
        label: 'Teaser V2',
        note: 'MD tightened the positioning line. Re-screened clear.',
        at: '2026-07-07T14:40:00.000Z',
      },
    ],
  },
};

function readStored(dealId: string): RailRunState {
  if (typeof window === 'undefined') return EMPTY;
  const owner = storeOwner();
  if (owner === null) return EMPTY;
  try {
    const raw = window.localStorage.getItem(key(dealId));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as StoredRunState;
    if (parsed.uid !== owner) {
      // Another user's entry, or an unstamped legacy one: never returned.
      window.localStorage.removeItem(key(dealId));
      return EMPTY;
    }
    return {
      receipts: parsed.receipts ?? {},
      versions: parsed.versions ?? {},
    };
  } catch {
    return EMPTY;
  }
}

function writeStored(dealId: string, state: RailRunState): void {
  if (typeof window === 'undefined') return;
  const owner = storeOwner();
  // No known owner (before the first auth event, after a sign-out): nothing
  // is persisted, so nothing can later be read back by someone else.
  if (owner === null) return;
  try {
    const stored: StoredRunState = { ...state, uid: owner };
    window.localStorage.setItem(key(dealId), JSON.stringify(stored));
    window.dispatchEvent(new Event(RAIL_RUN_EVENT));
  } catch {
    // ignore quota / disabled storage — the demo still works in-session
  }
}

/** The full run state for a deal, with fixture versions merged in. */
export function getRunState(dealId: string): RailRunState {
  const stored = readStored(dealId);
  const fixtures = FIXTURE_VERSIONS[dealId];
  if (!fixtures) return stored;
  const versions: Record<string, StepVersion[]> = { ...stored.versions };
  for (const [stepId, fixed] of Object.entries(fixtures)) {
    versions[stepId] = [...fixed, ...(stored.versions[stepId] ?? [])];
  }
  return { ...stored, versions };
}

/** Versions for one step (fixtures + appended), oldest first. */
export function stepVersions(dealId: string, stepId: string): StepVersion[] {
  return getRunState(dealId).versions[stepId] ?? [];
}

/** Log a run receipt on a step. */
export function addReceipt(
  dealId: string,
  stepId: string,
  receipt: Omit<StepReceipt, 'id' | 'at'>,
): StepReceipt {
  const full: StepReceipt = {
    ...receipt,
    id: `r-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    at: new Date().toISOString(),
  };
  const stored = readStored(dealId);
  writeStored(dealId, {
    ...stored,
    receipts: {
      ...stored.receipts,
      [stepId]: [...(stored.receipts[stepId] ?? []), full],
    },
  });
  return full;
}

/** Append a new version to a step's outputs list. Nothing is overwritten. */
export function appendVersion(
  dealId: string,
  stepId: string,
  label: string,
  note?: string,
): StepVersion {
  const existing = stepVersions(dealId, stepId);
  const version: StepVersion = {
    version: existing.length + 1,
    label,
    ...(note ? { note } : {}),
    at: new Date().toISOString(),
  };
  const stored = readStored(dealId);
  writeStored(dealId, {
    ...stored,
    versions: {
      ...stored.versions,
      [stepId]: [...(stored.versions[stepId] ?? []), version],
    },
  });
  return version;
}

/** Map a compliance verdict onto the receipt verdict. */
export function receiptVerdict(
  verdict: ComplianceCheckResult['verdict'],
): ReceiptVerdict {
  if (verdict === 'blocked') return 'blocked';
  if (verdict === 'hold') return 'hold';
  return 'clear';
}

/** Map a compliance verdict onto the shell ribbon status (SET_COMPLIANCE). */
export function ribbonStatus(
  verdict: ComplianceCheckResult['verdict'],
): ComplianceStatus {
  if (verdict === 'blocked') return 'blocked';
  if (verdict === 'hold') return 'hold';
  return 'clear';
}

/** Receipt check lines for a screen result: the pass set, or the reasons. */
export function receiptChecks(check: ComplianceCheckResult): string[] {
  if (check.verdict === 'compliant') return ['KYC ✓', 'FINRA ✓', 'MNPI ✓'];
  return check.reasons.length ? check.reasons : ['Flagged for supervisory review'];
}

export const RECEIPT_VERDICT_LABEL: Record<ReceiptVerdict, string> = {
  clear: 'Cleared',
  hold: 'Hold',
  blocked: 'Blocked',
};
