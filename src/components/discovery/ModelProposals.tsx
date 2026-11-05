'use client';

import * as React from 'react';
import Link from 'next/link';

import { Badge } from '@/components/atoms/Badge';
import { StageStatus } from '@/components/shell/StageStatus';
import type { ModelProposalGroup } from '@/lib/discovery/propose/group';
import { useFlag } from '@/lib/flags/FlagsContext';

import { dateRangeLabel } from './CandidateList';
import { ProposalActions } from './ProposalActions';

/**
 * ModelProposals: demo only (#460; removed when #459 lands). The deals a
 * model proposed from mail the codename rules did not route, read from
 * GET /api/v1/discovery/model-proposals under the viewer's own session.
 *
 * Each row has Promote (a proposed deal, `c:`), Accept (a deal only the
 * model named, G-02b) and Dismiss (every row), in ProposalActions (G-02a,
 * #173). A dismissal refetches the list, and the card says how many deals were
 * dismissed, so nothing disappears without a trace. While some accept is
 * pending (the source's job has yet to read its emails) the list reads again
 * every POLL_MS, at most POLL_LIMIT times, and never after the card unmounts; if one is still pending after the last
 * read, the card says "Still reading. Refresh later." (role=status). Ink-outlined like StepSuggestion, because it is a proposal, never
 * the deal's status; no violet (Casey only) and no status fill. It renders
 * nothing while the flag is off, while the list loads, when the route 404s and
 * when there is nothing to show, so a page without model proposals looks
 * exactly as it did before.
 */

/** How often the list reads again while an accept is pending, and how many times it does before it stops. */
export const POLL_MS = 15_000;
export const POLL_LIMIT = 40;
/** What the card says once the list stopped reading again while a group was still pending. Design to confirm (TH-6). */
export const STILL_READING = 'Still reading. Refresh later.';

export function emailsLabel(count: number): string {
  return `From ${count} ${count === 1 ? 'email' : 'emails'}`;
}

/**
 * What a `c:` row says about its deal: one the model made on accept, or one the codename rules also found. A deal whose
 * origin is not known (null) says nothing, so it never claims the codename rules found it.
 */
export function originCaption(origin: ModelProposalGroup['origin']): string {
  if (origin === null) return '';
  return origin === 'model_proposal' ? ', on a deal accepted from a model proposal' : ', on a deal the codename rules also found';
}

export function phaseLabel(phase: ModelProposalGroup['phase']): string {
  return `Phase ${phase.id.slice('phase-'.length)} · ${phase.name}`;
}

/** The quiet count of dismissed deals. */
export function dismissedLabel(count: number): string {
  return `${count} dismissed`;
}

function ProposalRow({
  proposal,
  onDismissed,
  onAccepted,
}: {
  proposal: ModelProposalGroup;
  onDismissed: (reference: string | null) => void;
  onAccepted: () => void;
}) {
  return (
    <li
      className="flex flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] py-[var(--space-4)] last:border-b-0"
      data-deal-key={proposal.dealKey}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-3)]">
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <h3 className="deal-identity text-[var(--ink)]">
            {proposal.candidateId ? (
              <Link href={`/discovery/${proposal.candidateId}`} className="hover:underline">
                {proposal.name}
              </Link>
            ) : (
              proposal.name
            )}
          </h3>
          <Badge tone="neutral">Proposed</Badge>
        </div>
        <span className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {dateRangeLabel(proposal.firstSentAt, proposal.lastSentAt)}
        </span>
      </div>
      {proposal.parties.length > 0 ? (
        <ul aria-label="Parties" className="flex list-none flex-wrap gap-[var(--space-2)] p-0">
          {proposal.parties.map((domain) => (
            <li key={domain}>
              <Badge tone="neutral">{domain}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">No outside party identified</span>
      )}
      <p className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{phaseLabel(proposal.phase)}</p>
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {emailsLabel(proposal.emails)}
        {proposal.candidateId ? originCaption(proposal.origin) : null}
      </p>
      <ProposalActions proposal={proposal} onDismissed={onDismissed} onAccepted={onAccepted} />
    </li>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'error' }
  | { status: 'ready'; proposals: ModelProposalGroup[]; dismissedCount: number };

export function ModelProposals() {
  const enabled = useFlag('discovery_model_proposals_demo');
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  // A dismissal asks for a fresh read; the list it holds stays on screen until that read settles. Its restore
  // reference stays on the card until the next dismissal (or the next visit).
  const [reloads, setReloads] = React.useState(0);
  const [reference, setReference] = React.useState<string | null>(null);
  const dismissed = React.useCallback((ref: string | null) => {
    setReference(ref);
    setReloads((n) => n + 1);
  }, []);
  // An accept asks for a fresh read too, to show the row as pending.
  const reload = React.useCallback(() => setReloads((n) => n + 1), []);
  const pending = state.status === 'ready' && state.proposals.some((p) => p.accept?.state === 'pending');

  // The timer gave up while a group was still pending: the card then says so, once, until nothing is pending again.
  const [gaveUp, setGaveUp] = React.useState(false);

  // Only while some group is pending: read again on a timer, a bounded number of times. The boolean keeps the timer
  // running across the reads it triggers; it ends when nothing is pending, at the limit, and on unmount.
  React.useEffect(() => {
    if (!pending) return;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks > POLL_LIMIT) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      setReloads((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      setGaveUp(false);
    };
  }, [pending]);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/v1/discovery/model-proposals', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`discovery model proposals: ${res.status}`);
        return (await res.json()) as { proposals?: ModelProposalGroup[]; dismissedCount?: number };
      })
      .then((data) => {
        if (cancelled) return;
        setState(
          data === null
            ? { status: 'hidden' }
            : { status: 'ready', proposals: data.proposals ?? [], dismissedCount: data.dismissedCount ?? 0 },
        );
      })
      .catch(() => {
        // A read that fails after the list was shown (a poll, a refresh) keeps the list; only the first read errors.
        if (!cancelled) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, reloads]);

  if (!enabled || state.status === 'loading' || state.status === 'hidden') return null;

  if (state.status === 'error') {
    return (
      <div className="mt-[var(--space-8)]">
        <StageStatus kind="error">
          <p role="alert">Model proposals could not be loaded. Try again shortly.</p>
        </StageStatus>
      </div>
    );
  }

  // Once something was dismissed the card stays, even with every row gone, so the count is still on screen.
  if (state.proposals.length === 0 && state.dismissedCount === 0) return null;

  return (
    <section
      aria-label="Proposed from mail by a model"
      className="mt-[var(--space-8)] flex flex-col rounded-[var(--radius-card)] border border-[var(--accent)] bg-[var(--surface)] px-[var(--space-5)] pt-[var(--space-4)] pb-[var(--space-2)] shadow-[var(--elev-1)]"
    >
      <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        Proposed from mail by a model · demo
      </p>
      <p className="mt-[var(--space-1)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Mail the codename rules did not route. A model named the deal and its phase. Each one is a proposal to check,
        not a finding.
      </p>
      {state.dismissedCount > 0 ? (
        <p className="mt-[var(--space-1)] font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {dismissedLabel(state.dismissedCount)}
        </p>
      ) : null}
      {pending && gaveUp ? (
        <p role="status" className="mt-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {STILL_READING}
        </p>
      ) : null}
      {reference ? (
        <p role="status" className="mt-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          Dismissed. Restore reference <span className="select-all font-mono">{reference}</span>
        </p>
      ) : null}
      {state.proposals.length > 0 ? (
        <ul className="flex list-none flex-col p-0">
          {state.proposals.map((proposal) => (
            <ProposalRow key={proposal.dealKey} proposal={proposal} onDismissed={dismissed} onAccepted={reload} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default ModelProposals;
