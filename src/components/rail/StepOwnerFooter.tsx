'use client';

import * as React from 'react';

import type { StepOwnerSummary } from '@/lib/rail/boardContract';
import { formatRelative } from '@/lib/format/date';
import type { StepActivity } from '@/lib/rail/stepActivity';
import { initialsOf } from './railBoardModel';

const ACTIVITY_VERB: Record<StepActivity['kind'], string> = {
  draft_saved: 'Draft saved by',
  assigned: 'Assigned by',
  completed: 'Done by',
};

/** "Draft saved by Alex Chen · 2h ago": the actor, the action, when. */
export function activityLine(activity: StepActivity, now: number = Date.now()): string {
  const when = formatRelative(activity.at, now);
  return `${ACTIVITY_VERB[activity.kind]} ${activity.actorName}${when ? ` · ${when}` : ''}`;
}

/**
 * The people lines under a step card's title: who owns the step ("Unassigned"
 * when nobody does) and the last thing done on it, from the audit trail.
 * Both are facts; neither claims anyone is working right now.
 */
export function StepOwnerFooter({
  owner,
  showUnassigned = true,
  now,
}: {
  owner: StepOwnerSummary | undefined;
  /** An open step names its owner or says "Unassigned"; a closed one names an owner only. */
  showUnassigned?: boolean;
  now?: number;
}) {
  const name = owner?.owner?.name;
  const activity = owner?.activity;
  if (!name && !showUnassigned && !activity) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-[var(--stroke)] pt-[var(--space-2)]">
      {name ? (
        <p className="flex min-w-0 items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--surface-subtle)] text-[length:var(--text-xxs)] font-semibold text-[var(--ink-secondary)]"
          >
            {owner?.owner?.initials || initialsOf(name)}
          </span>
          <span className="sr-only">Owner: </span>
          <span className="min-w-0 truncate">{name}</span>
        </p>
      ) : showUnassigned ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">Unassigned</p>
      ) : null}
      {activity ? (
        <p
          data-activity={activity.kind}
          className="text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]"
        >
          {activityLine(activity, now)}
        </p>
      ) : null}
    </div>
  );
}

export default StepOwnerFooter;
