'use client';

import * as React from 'react';

import type { CandidateEvidence } from '@/lib/discovery/api';
import { reasonDate } from '@/lib/discovery/reason';

/**
 * The mail the suggested step rests on. The viewer's own mail shows the
 * cited sentence in Georgia with the cited span marked; a colleague's mail is
 * listed as metadata only, with its date and nothing of its text. Mail the
 * viewer reads as a member of a team inbox carries a "Team inbox" line (wording
 * and look: design to confirm, #173 T-4).
 */
function dayOf(sentAt: string | null): string | null {
  return sentAt && /^\d{4}-\d{2}-\d{2}/.test(sentAt) ? reasonDate(sentAt.slice(0, 10)) : null;
}

export function EvidenceExcerpt({ item }: { item: CandidateEvidence }) {
  const day = dayOf(item.sentAt);
  return (
    <li className="flex flex-col gap-[var(--space-1)] border-b border-[var(--stroke)] py-[var(--space-4)] last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)]">
        <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
          {item.own ? item.subject : "From another banker's mailbox · metadata only"}
        </span>
        {day ? (
          <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">{day}</span>
        ) : null}
      </div>
      {item.team ? (
        <span className="text-[length:var(--text-xs)] font-medium text-[var(--ink-tertiary)]">Team inbox</span>
      ) : null}
      {item.own && item.excerpt ? (
        <blockquote className="font-[family-name:var(--font-display)] text-[length:var(--text-md)] leading-relaxed text-[var(--ink-secondary)]">
          {item.excerpt.text.slice(0, item.excerpt.highlight[0])}
          <mark className="bg-[var(--hold-tint)] text-[var(--ink)]">
            {item.excerpt.text.slice(item.excerpt.highlight[0], item.excerpt.highlight[1])}
          </mark>
          {item.excerpt.text.slice(item.excerpt.highlight[1])}
        </blockquote>
      ) : null}
    </li>
  );
}

export function EvidenceList({ evidence }: { evidence: CandidateEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <section aria-label="Evidence" className="flex flex-col gap-[var(--space-2)]">
      <h2 className="bank-label">Evidence</h2>
      <ul className="flex list-none flex-col rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-2)]">
        {evidence.map((item) => (
          <EvidenceExcerpt key={item.sourceItemId} item={item} />
        ))}
      </ul>
    </section>
  );
}

export default EvidenceExcerpt;
