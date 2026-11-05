/**
 * The Book home's read model (#191): the live deal list (useDeals) as Book
 * rows. Every deck-mockup field has graduated — close date, fee, schedule
 * status and lifecycle category are the deal's own columns, set by the MD —
 * so the mock-scale fixture is no longer consulted here at all. A deal
 * without a value shows none; the category always exists (default 'live').
 */

import type { FixtureDeal } from '../rail/deals';
import type { LifecycleCategory, ScheduleStatus } from '../constants/deals';
import { formatDate } from '@/lib/format/date';

export type BookRow = {
  /** Routing id for /projects/[id] links. */
  id: string;
  codename: string;
  code: string;
  /** Human-readable phase label (FixtureDeal.status). */
  stage: string;
  category: LifecycleCategory;
  closeDate: string | null;
  scheduleStatus: ScheduleStatus | null;
  feeUsd: number | null;
};

/** $5.1M-style compact fee, scaling through M, B and T. */
export function formatFee(feeUsd: number): string {
  const scales = [
    [1_000_000_000_000, 'T'],
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
  ] as const;
  for (const [unit, suffix] of scales) {
    if (Math.abs(feeUsd) >= unit) return `$${(feeUsd / unit).toFixed(1)}${suffix}`;
  }
  return `$${Math.round(feeUsd).toLocaleString('en-US')}`;
}

/** Oct 9, 2026-style close date. */
export function formatCloseDate(iso: string): string {
  return formatDate(`${iso}T00:00:00Z`, { timeZone: 'UTC' });
}

export function toBookRows(deals: readonly FixtureDeal[]): BookRow[] {
  const rows = deals.map((deal) => {
    return {
      id: deal.id,
      codename: deal.codename,
      code: deal.code,
      stage: deal.status,
      category: deal.lifecycleCategory ?? 'live',
      closeDate: deal.targetCloseDate ?? null,
      scheduleStatus: deal.scheduleStatus ?? null,
      feeUsd: deal.feeUsd ?? null,
    };
  });
  // Slide order: nearest close first; deals without a date sink to the end.
  return rows.sort((a, b) => {
    if (a.closeDate && b.closeDate) return a.closeDate.localeCompare(b.closeDate);
    if (a.closeDate) return -1;
    if (b.closeDate) return 1;
    return a.codename.localeCompare(b.codename);
  });
}
