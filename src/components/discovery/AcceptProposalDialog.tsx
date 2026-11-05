'use client';

import * as React from 'react';

import type { ModelProposalProposed } from '@/lib/discovery/propose/group';
import { proposalReason } from '@/lib/discovery/propose/station';
import { MVP_DEAL_RAIL, orderedSteps, stepDisplayNumber } from '@/lib/rail/dealRail';
import { useModalDialog } from '@/lib/ui/useModalDialog';

/**
 * Confirms accepting one model-only (`m:`) proposal as a proposed deal (G-02b, #173): demo only, like the proposals
 * (#460; removed when #459 lands). It POSTs the group's key and the station the list showed to
 * /api/v1/discovery/model-proposals/accept, which only records the request: the source's next sync job reads the
 * emails again through the mailbox guard and the exclusion policy. The dialog says so, shows the station the model
 * proposes with its reason, and says that no station is set until the MD confirms it on the deal.
 *
 * Same shell as DismissProposalDialog: the footer follows the Workbench kit (left-aligned, primary first), ink only,
 * no violet and no status fill. While the request is in flight nothing closes the dialog (Escape, the backdrop,
 * Cancel), so its outcome is never lost, and a double click posts once.
 *
 * A 202 hands over (`onDone`): the list then shows the pending row. A 404 does too: the proposal is gone, so the fresh
 * list is the answer. A 409 `candidate_closed` or `proposal_changed` (the station sent is no longer the group's) is
 * final: the dialog keeps the server's fixed text, disables the primary, and asks the list to refresh (`onStale`), so
 * the row shows the new proposal. Any other answer keeps the dialog open with the server's fixed
 * text so the MD can try again. Design to confirm (TH-6): the "Proposed step" block follows the Workbench
 * filled-field surface, like the Set station dialog's; the incoming designer sets its final weight.
 */

const FALLBACK_ERROR = 'The proposal could not be accepted. Try again shortly.';
/** The server's fixed text for a 409 `proposal_changed`, used only if the body carries none. */
const CHANGED_ERROR = 'This proposal changed. Review it again.';

type Outcome = { kind: 'accepted' } | { kind: 'gone' } | { kind: 'closed'; error: string } | { kind: 'error'; error: string };

/** POSTs one accept request and sorts the answer. */
async function postAccept(dealKey: string, proposedStepId: string): Promise<Outcome> {
  try {
    const res = await fetch('/api/v1/discovery/model-proposals/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dealKey, proposedStepId }),
    });
    if (res.ok) return { kind: 'accepted' };
    if (res.status === 404) return { kind: 'gone' };
    const payload = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const error = typeof payload.error === 'string' && payload.error ? payload.error : FALLBACK_ERROR;
    // A plain 409 is the lock timing out: retry. A 409 with a code is final: the deal was rejected meanwhile
    // (`candidate_closed`), or the station sent is no longer the group's (`proposal_changed`).
    if (res.status === 409 && payload.code === 'candidate_closed') return { kind: 'closed', error };
    if (res.status === 409 && payload.code === 'proposal_changed') {
      return { kind: 'closed', error: typeof payload.error === 'string' && payload.error ? payload.error : CHANGED_ERROR };
    }
    return { kind: 'error', error };
  } catch {
    return { kind: 'error', error: FALLBACK_ERROR };
  }
}

/** "NN · title" of a rail step, or null when the rail does not have it. */
function stationLabel(stepId: string): string | null {
  const step = orderedSteps(MVP_DEAL_RAIL).find((s) => s.id === stepId);
  if (!step) return null;
  return `${String(stepDisplayNumber(step.id, MVP_DEAL_RAIL)).padStart(2, '0')} · ${step.title}`;
}

export function AcceptProposalDialog({
  dealKey,
  name,
  proposed,
  onClose,
  onDone,
  onStale,
}: {
  /** The group's `m:` key. It is posted, never shown. */
  dealKey: string;
  name: string;
  /** The station the model proposes and the numbers behind it, as the list reader computed them. */
  proposed: ModelProposalProposed;
  onClose: () => void;
  /** The request was recorded (or the proposal is gone): refresh the list. */
  onDone: () => void;
  /** The deal was rejected or the proposal changed meanwhile: the dialog stays on its message, the list refreshes behind it. */
  onStale?: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [final, setFinal] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const close = React.useCallback(() => {
    if (!submittingRef.current) onClose();
  }, [onClose]);
  useModalDialog(dialogRef, close);

  const submit = React.useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const outcome = await postAccept(dealKey, proposed.stepId);
    submittingRef.current = false;
    setSubmitting(false);
    if (outcome.kind === 'accepted' || outcome.kind === 'gone') {
      onDone();
      return;
    }
    setError(outcome.error);
    if (outcome.kind === 'closed') {
      setFinal(true);
      onStale?.();
    }
  }, [dealKey, proposed.stepId, onDone, onStale]);

  const station = stationLabel(proposed.stepId);
  const reason = proposalReason(proposed);
  const emails = `${proposed.of} ${proposed.of === 1 ? 'email' : 'emails'}`;
  const title = `Accept ${name} as a proposed deal`;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[color-mix(in_srgb,var(--ink)_55%,transparent)] p-[var(--space-4)]"
      onClick={close}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)] shadow-[var(--shadow-ambient)]"
      >
        <p className="eyebrow">Model proposal · logged</p>
        <h2 className="mt-1 text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">{title}</h2>
        <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          The {emails} {proposed.of === 1 ? 'is' : 'are'} read again through the mailbox guard and the exclusion
          policy. Those still admitted become this deal&apos;s evidence.
        </p>

        {station ? (
          <div className="mt-[var(--space-3)] rounded-[var(--radius-input)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)]">
            <span className="bank-label">Proposed step</span>
            <p className="font-mono text-[length:var(--text-sm)] font-medium text-[var(--ink)]">{station}</p>
            <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{reason}.</p>
          </div>
        ) : null}
        <p className="mt-[var(--space-3)] border-l-2 border-[var(--stroke-strong)] pl-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          No step is set until you confirm it on the deal.
        </p>

        {error ? (
          <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            {error}
          </p>
        ) : null}

        <div className="mt-[var(--space-4)] flex items-center justify-start gap-[var(--space-2)]">
          <button
            type="button"
            disabled={submitting || final}
            onClick={submit}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Accept and read {emails}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={close}
            className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default AcceptProposalDialog;
