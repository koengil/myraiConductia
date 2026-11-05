'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import type { AcceptFailureCode, ModelProposalGroup } from '@/lib/discovery/propose/group';

import { AcceptProposalDialog } from './AcceptProposalDialog';
import { ACTION_BUTTON, PROMOTED_REASON } from './CandidateActions';
import { DismissProposalDialog } from './DismissProposalDialog';

/** What an `m:` row says when its accept ended without a deal (design R9): one fixed sentence per code, no detail. */
export const ACCEPT_FAILURE_COPY: Record<AcceptFailureCode, string> = {
  none_readable: 'None of these emails can be read now.',
  source_unavailable: 'The mailbox is not readable now.',
  candidate_closed: 'This proposed deal was rejected.',
  error: 'Could not accept the proposal. Try again shortly.',
};

/** "Reading 4 emails again": the pending row's line while the source's next sync job does the accept. */
export function readingLabel(count: number): string {
  return `Reading ${count} ${count === 1 ? 'email' : 'emails'} again`;
}

/**
 * What the MD can do to one model proposal (G-02a, #173): demo only, like the proposals (#460; removed when #459
 * lands).
 *
 * - "Promote to mandate", on a proposed deal (`c:`: one the codename rules found, or one accepted from a model proposal), only navigates: it opens the candidate's
 *   page with ?promote=1, where the existing Promote dialog and Gate 0 route do the work and decide who may. It is
 *   disabled, with the reason, when that candidate is already a mandate. On an accepted deal the Promote dialog starts
 *   unpicked: it never preselects a station the model chose.
 * - "Dismiss", on every row, confirms and then records an audited dismissal that keeps the proposal on record.
 *
 * A deal only the model named (`m:`, G-02b) is accepted instead: "Accept as proposed deal" opens a dialog that records
 * the request. While the source's job has it, the row says "Reading N emails again" and has no buttons; once it is
 * done the group comes back as a `c:` deal. A failed accept shows its fixed sentence with Dismiss, and "Accept again"
 * only for `error` (the other codes would fail the same way). A group that is not `actionable` (a row from a team inbox, or any source the viewer does not own) shows no actions at all until TH1-3
 * decides team triage: the dismiss RPC would refuse it anyway. The buttons share CandidateActions' outlined style:
 * no violet, no status fill and no red, because dismissing archives.
 */
export function ProposalActions({
  proposal,
  onDismissed,
  onAccepted,
}: {
  proposal: ModelProposalGroup;
  /** Called after a dismissal with its restore reference (null when nothing new was written). */
  onDismissed: (reference: string | null) => void;
  /** Called after an accept was recorded, or found stale: the list reads again. */
  onAccepted: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [accepting, setAccepting] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const closeAccept = React.useCallback(() => setAccepting(false), []);
  const accepted = React.useCallback(() => {
    setAccepting(false);
    onAccepted();
  }, [onAccepted]);
  const done = React.useCallback(
    (reference: string | null) => {
      setOpen(false);
      onDismissed(reference);
    },
    [onDismissed],
  );

  if (!proposal.actionable) return null;
  const candidateId = proposal.dealKey.startsWith('c:') ? proposal.candidateId : null;
  const { accept, proposed } = proposal;

  // The source's job has the request: nothing to click until it ends. Design to confirm (TH-6): a quiet inline line
  // with the StageStatus loading marker's calm pulse, not its full-page frame.
  if (accept?.state === 'pending') {
    return (
      <p
        role="status"
        className="flex items-center gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
      >
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-[var(--ink-quiet)] motion-safe:animate-pulse" />
        {readingLabel(accept.requested)}
      </p>
    );
  }
  // Accept is for a model-only deal the viewer owns; "Accept again" only after an `error`.
  const canAccept = proposed !== null && (accept === null || accept.code === 'error');

  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      {accept?.state === 'failed' ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{ACCEPT_FAILURE_COPY[accept.code]}</p>
      ) : null}
      <div className="flex flex-wrap gap-[var(--space-2)]">
        {candidateId ? (
          <button
            type="button"
            disabled={proposal.promoted}
            title={proposal.promoted ? PROMOTED_REASON : undefined}
            onClick={() => router.push(`/discovery/${encodeURIComponent(candidateId)}?promote=1`)}
            className={ACTION_BUTTON}
          >
            Promote to mandate
          </button>
        ) : null}
        {canAccept ? (
          <button type="button" onClick={() => setAccepting(true)} className={ACTION_BUTTON}>
            {accept ? 'Accept again' : 'Accept as proposed deal'}
          </button>
        ) : null}
        <button type="button" onClick={() => setOpen(true)} className={ACTION_BUTTON}>
          Dismiss
        </button>
      </div>
      {candidateId && proposal.promoted ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{PROMOTED_REASON}</p>
      ) : null}
      {open ? (
        <DismissProposalDialog dealKey={proposal.dealKey} name={proposal.name} onClose={close} onDone={done} />
      ) : null}
      {accepting && proposed ? (
        <AcceptProposalDialog
          dealKey={proposal.dealKey}
          name={proposal.name}
          proposed={proposed}
          onClose={closeAccept}
          onDone={accepted}
          onStale={onAccepted}
        />
      ) : null}
    </div>
  );
}

export default ProposalActions;
