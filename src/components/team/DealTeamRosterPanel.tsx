'use client';

import * as React from 'react';

import { Badge } from '@/components/atoms';
import type { ResolvedTeamMember } from '@/lib/rail/dealTeam';

function RosterListSection({
  title,
  members,
}: {
  title: string;
  members: ResolvedTeamMember[];
}) {
  if (!members.length) return null;

  return (
    <section aria-label={title}>
      <h3 className="bank-label mb-[var(--space-2)]">{title}</h3>
      <ul className="flex flex-col">
        {members.map((m, i) => (
          <li
            key={m.id}
            className={
              'flex items-start gap-[var(--space-4)] py-[var(--space-3)]' +
              (i > 0 ? ' border-t border-[var(--stroke)]' : '')
            }
          >
            <span
              aria-hidden="true"
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--stroke)] bg-[var(--surface-subtle)] font-mono text-(length:--text-sm) font-medium tracking-[0.02em] text-[var(--ink-secondary)]"
            >
              {m.initials}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
              <span className="flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[2px]">
                <span className="truncate font-sans text-(length:--text-md) font-medium tracking-tight text-[var(--ink)]">
                  {m.name}
                </span>
                <Badge tone="neutral">{m.role}</Badge>
              </span>
              <span className="font-sans text-(length:--text-xs) text-[var(--ink-tertiary)]">
                Added by {m.addedBy} on{' '}
                <span className="font-mono tabular-nums">{m.addedOn}</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={
        'pb-[var(--space-2)] pr-[var(--space-3)] text-left font-sans text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)] last:pr-0 ' +
        className
      }
    >
      {children}
    </th>
  );
}

function RosterTableSection({
  title,
  members,
}: {
  title: string;
  members: ResolvedTeamMember[];
}) {
  if (!members.length) return null;

  return (
    <section aria-label={title} className="flex flex-col gap-[var(--space-2)]">
      <h3 className="bank-label">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--stroke)]">
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Added by</Th>
              <Th className="whitespace-nowrap">On deal since</Th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="h-[52px] border-b border-[var(--stroke)] last:border-b-0">
                <td className="py-[var(--space-3)] pr-[var(--space-3)]">
                  <span className="flex items-center gap-[var(--space-3)]">
                    <span
                      aria-hidden="true"
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--stroke)] bg-[var(--surface-subtle)] font-mono text-(length:--text-xs) font-medium tracking-[0.02em] text-[var(--ink-secondary)]"
                    >
                      {m.initials}
                    </span>
                    <span className="font-sans text-(length:--text-sm) font-medium tracking-tight text-[var(--ink)]">
                      {m.name}
                    </span>
                  </span>
                </td>
                <td className="py-[var(--space-3)] pr-[var(--space-3)] align-middle">
                  <Badge tone="neutral">{m.role}</Badge>
                </td>
                <td className="py-[var(--space-3)] pr-[var(--space-3)] align-middle font-sans text-(length:--text-sm) text-[var(--ink-secondary)]">
                  {m.addedBy}
                </td>
                <td className="py-[var(--space-3)] align-middle font-mono text-(length:--text-sm) tabular-nums text-[var(--ink)]">
                  {m.addedOn}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Shared intake / later roster breakdown for the rail Team step and /team destination. */
export function DealTeamRosterPanel({
  intake,
  later,
  layout = 'list',
}: {
  intake: ResolvedTeamMember[];
  later: ResolvedTeamMember[];
  layout?: 'list' | 'table';
}) {
  const Section = layout === 'table' ? RosterTableSection : RosterListSection;

  return (
    <div className="flex flex-col gap-[var(--space-5)]">
      <Section title="Assigned at project creation" members={intake} />
      {later.length > 0 ? (
        <Section title="Added later on the project" members={later} />
      ) : null}
    </div>
  );
}
