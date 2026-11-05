'use client';

import * as React from 'react';

import { formatDate } from '@/lib/format/date';
import type { RailHeaderProgress } from './railBoardModel';

/**
 * The truthful line about rail edit rights. The right is company-wide today
 * (`resolveDealStepStructureCapability` takes no deal), so the line names the
 * right, never a deal role. Per-deal rights are handoff E3
 * (Per-deal rail edit rights and "Propose a change") and the question for Storm
 * "Who changes the rail for everyone, and who approves?".
 */
export const WHO_CAN_CHANGE = 'People with rail editing rights change this rail.';

/**
 * The rail's header: one progress line ("Preparation · 4 of 13 steps done"),
 * one bar for the whole rail and the target close. The deal's name shows once,
 * in the top navigation's deal switcher, so it is not repeated on screen here;
 * the heading still carries it for assistive technology, so the page keeps one
 * heading that names the deal. Numbers stay quiet beside the phase name.
 */
export function RailHeader({
  dealName,
  progress,
  targetCloseDate,
  entryLine,
  actions,
  beside,
}: {
  /** The deal's codename: read by assistive technology, never shown twice. */
  dealName?: string;
  progress: RailHeaderProgress;
  targetCloseDate?: string | null;
  /** Where a deal that opened partway down the rail came in. */
  entryLine?: React.ReactNode;
  actions?: React.ReactNode;
  /** Beside the target close: the soonest Preview step date, when one is set. */
  beside?: React.ReactNode;
}) {
  // A calendar day stored as YYYY-MM-DD: read it in UTC so it never shifts a day.
  const close = targetCloseDate ? formatDate(targetCloseDate, { timeZone: 'UTC' }) : '';
  return (
    <header className="mb-[var(--space-5)] flex flex-wrap items-end justify-between gap-[var(--space-3)]">
      <div className="min-w-0">
        <h1 className="text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink)]">
          {dealName ? (
            <>
              <span className="sr-only">{dealName}</span>{' '}
            </>
          ) : null}
          Rail
        </h1>
        <p
          data-testid="rail-progress-line"
          className="mt-1 text-[length:var(--text-md)] font-medium tracking-[-0.35px] text-[var(--ink)]"
        >
          {progress.line}
        </p>
        {entryLine}
        <p
          data-testid="rail-who-can-change"
          className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
        >
          {WHO_CAN_CHANGE}
        </p>
        <div className="mt-[var(--space-2)] flex flex-wrap items-center gap-x-[var(--space-4)] gap-y-[var(--space-2)]">
          {/* One pill for the whole rail: mark, bar, percent. */}
          <span className="inline-flex items-center gap-[11px] rounded-[var(--radius-pill)] border border-[var(--stroke-strong)] px-1.5 py-1">
            <span aria-hidden className="relative block size-3.5 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt=""
                src="/rail/rail-progress.svg"
                className="absolute inset-[-14.29%] block size-[calc(100%+4px)] max-w-none"
              />
            </span>
            <span
              role="progressbar"
              aria-label="Rail progress"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
              aria-valuetext={`${progress.done} of ${progress.total} steps done on the whole rail`}
              className="block h-[7px] w-[79px] overflow-hidden rounded-[var(--radius-pill)] bg-[var(--stroke-strong)]"
            >
              <span
                className="block h-full rounded-[var(--radius-pill)] bg-[var(--ink-secondary)] transition-[width] duration-300"
                style={{ width: `${progress.pct}%` }}
              />
            </span>
            <span className="whitespace-nowrap text-[length:var(--text-xs)] tabular-nums text-[var(--ink-secondary)]">
              {progress.pct}% of the rail
            </span>
          </span>
          <span className="whitespace-nowrap text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {close ? (
              <>
                Target close <span className="text-[var(--ink-secondary)]">{close}</span>
              </>
            ) : (
              'No target close set'
            )}
          </span>
          {beside}
        </div>
      </div>
      {actions ? (
        <div
          // 44px touch targets below sm; the desktop sizes stay.
          data-rail-header-actions
          className="flex flex-wrap items-center gap-[var(--space-2)] [&_button]:min-h-11 sm:[&_button]:min-h-0"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export default RailHeader;
