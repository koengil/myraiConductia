'use client';

import * as React from 'react';

import type { CandidateDecision } from '@/lib/discovery/api';
import { reasonDate } from '@/lib/discovery/reason';
import { MVP_DEAL_RAIL, orderedSteps, stepDisplayNumber } from '@/lib/rail/dealRail';

/**
 * The decisions people made on a proposed deal, oldest first: who, what, when,
 * why and the value before. A sentence each, for example "Storm Duncan set the
 * step to 44 · LOI Review on Oct 2, 2026. Reason: signed by phone. Before:
 * suggested 43." The log is append-only, so this page only ever gains lines.
 */
function stationOf(stepId: unknown): string | null {
  if (typeof stepId !== 'string') return null;
  const step = orderedSteps(MVP_DEAL_RAIL).find((s) => s.id === stepId);
  if (!step) return null;
  return `${stepDisplayNumber(stepId, MVP_DEAL_RAIL)} · ${step.title}`;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** One decision as a sentence. `thisCandidateId` decides whether a merge went out of this deal or into it. */
export function decisionSentence(d: CandidateDecision, thisCandidateId: string): string {
  const when = /^\d{4}-\d{2}-\d{2}/.test(d.at) ? reasonDate(d.at.slice(0, 10)) : d.at;
  const who = d.actorName;
  const why = d.reason ? ` Reason: ${d.reason}.` : '';
  switch (d.action) {
    case 'rename': {
      const before = str(d.before?.name);
      return `${who} renamed this proposed deal to ${str(d.after?.name) ?? 'a new name'} on ${when}.${why}${before ? ` Before: ${before}.` : ''}`;
    }
    case 'reject':
      return `${who} rejected this proposed deal on ${when}.${why}`;
    case 'set_station': {
      const after = stationOf(d.after?.stepId);
      const previous = stationOf(d.before?.stepId);
      const suggested = stationOf(d.before?.suggestedStepId);
      const before = previous
        ? ` Before: ${previous}.`
        : suggested
          ? ` Before: suggested ${suggested.split(' · ')[0]}.`
          : '';
      return `${who} set the step to ${after ?? 'a step no longer on the rail'} on ${when}.${why}${before}`;
    }
    case 'merge': {
      if (d.candidateId === thisCandidateId) {
        return `${who} merged this proposed deal into ${str(d.after?.survivorName) ?? 'another proposed deal'} on ${when}.${why}`;
      }
      return `${who} merged ${str(d.before?.name) ?? 'another proposed deal'} into this proposed deal on ${when}.${why}`;
    }
    case 'split': {
      const count = Number(d.after?.itemCount);
      if (d.candidateId === thisCandidateId) {
        const moved = Number.isInteger(count) && count > 0 ? (count === 1 ? '1 email' : `${count} emails`) : 'emails';
        return `${who} split ${moved} off this proposed deal into ${str(d.after?.newName) ?? 'a new proposed deal'} on ${when}.${why}`;
      }
      return `${who} split this proposed deal off ${str(d.before?.name) ?? 'another proposed deal'} on ${when}.${why}`;
    }
    case 'reassign': {
      if (d.candidateId === thisCandidateId) {
        return `${who} moved an email from this proposed deal to ${str(d.after?.targetName) ?? 'another proposed deal'} on ${when}.${why}`;
      }
      return `${who} moved an email from ${str(d.before?.name) ?? 'another proposed deal'} to this proposed deal on ${when}.${why}`;
    }
    case 'accept_proposal': {
      // The worker writes the counts when the accepted emails are linked: how many it read, of how many it grouped.
      const found = Number(d.after?.found);
      const requested = Number(d.after?.requested);
      const counted =
        Number.isInteger(found) && Number.isInteger(requested) && found >= 0 && requested > 0
          ? ` ${found} of ${requested} ${requested === 1 ? 'email was' : 'emails were'} read.`
          : '';
      return `${who} accepted this proposed deal from a model proposal on ${when}.${counted}${why}`;
    }
    default:
      return `${who} changed this proposed deal on ${when}.${why}`;
  }
}

export function DecisionHistory({
  decisions,
  candidateId,
}: {
  decisions: CandidateDecision[];
  candidateId: string;
}) {
  if (decisions.length === 0) return null;
  return (
    <section aria-label="Decision history" className="flex flex-col gap-[var(--space-2)]">
      <h2 className="bank-label">Decision history</h2>
      <ol className="flex list-none flex-col rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-2)]">
        {decisions.map((d) => (
          <li
            key={d.id}
            className="border-b border-[var(--stroke)] py-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)] last:border-b-0"
          >
            {decisionSentence(d, candidateId)}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default DecisionHistory;
