'use client';

import * as React from 'react';

import type { CandidateMilestone } from '@/lib/discovery/api';
import { reasonDate } from '@/lib/discovery/reason';

/**
 * The milestones found in mail the viewer can see, oldest first. The source
 * column says whose mailbox it came from and nothing more: a colleague's mail
 * is never named or quoted here, and mail the viewer reads as a member of a
 * team inbox reads "Team inbox" (wording and look: design to confirm, #173 T-4).
 */
export function sourceLabel(own: boolean, team = false): string {
  if (team) return 'Team inbox';
  return own ? 'Your mailbox' : "Another banker's mailbox";
}

export function MilestoneTimeline({ milestones }: { milestones: CandidateMilestone[] }) {
  if (milestones.length === 0) return null;
  const head = 'pb-[var(--space-2)] pr-[var(--space-3)] text-left text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]';
  return (
    <section aria-label="Milestones" className="flex flex-col gap-[var(--space-2)]">
      <h2 className="bank-label">Milestones</h2>
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]">
        <table className="w-full min-w-[28rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--stroke)]">
              <th scope="col" className={head}>Milestone</th>
              <th scope="col" className={head}>Date</th>
              <th scope="col" className={head}>Source</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((m) => (
              <tr key={m.id} className="h-[52px] border-b border-[var(--stroke)] last:border-b-0">
                <td className="pr-[var(--space-3)] text-[length:var(--text-sm)] font-medium text-[var(--ink)]">{m.label}</td>
                <td className="pr-[var(--space-3)] font-mono text-[length:var(--text-sm)] tabular-nums text-[var(--ink)]">
                  {reasonDate(m.occurredAt)}
                </td>
                <td className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{sourceLabel(m.own, m.team)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default MilestoneTimeline;
