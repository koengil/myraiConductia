'use client';

import * as React from 'react';

import { useModalDialog } from '@/lib/ui/useModalDialog';

/**
 * Confirms dismissing one model proposal (G-02a, #173): demo only, like the proposals (#460; removed when #459
 * lands). It POSTs the group's key to /api/v1/discovery/model-proposals/dismiss, which records the dismissal on the
 * owner's own session and keeps the proposal rows on record. No reason field: a free-text reason would be more
 * mail-derived text to purge.
 *
 * A 200 and a 404 both close the dialog and refresh the list: a 404 means the proposal is no longer there to dismiss
 * (its candidate was rejected in another tab, say), so the fresh list is the answer. A 200 hands back the
 * operation's id, the content-free reference the owner quotes to ask for a restore. Any other answer keeps the
 * dialog open with the server's fixed text. While the request is in flight, nothing closes the dialog (Escape, the
 * backdrop, Cancel), so its outcome is never lost. The footer follows the Workbench kit: left-aligned, primary
 * first.
 */

const FALLBACK_ERROR = 'The proposal could not be dismissed. Try again shortly.';

type Outcome = { done: true; reference: string | null } | { done: false; error: string };

/** POSTs one dismissal: done (refresh the list, with the reference when one was written), else the message to show. */
async function postDismissal(dealKey: string): Promise<Outcome> {
  try {
    const res = await fetch('/api/v1/discovery/model-proposals/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ dealKey }),
    });
    if (res.status === 404) return { done: true, reference: null };
    const payload = (await res.json().catch(() => ({}))) as { error?: unknown; operationId?: unknown };
    if (res.ok) return { done: true, reference: typeof payload.operationId === 'string' ? payload.operationId : null };
    return { done: false, error: typeof payload.error === 'string' && payload.error ? payload.error : FALLBACK_ERROR };
  } catch {
    return { done: false, error: FALLBACK_ERROR };
  }
}

export function DismissProposalDialog({
  dealKey,
  name,
  onClose,
  onDone,
}: {
  /** The group's key, `c:<uuid>` or `m:<slug>`. It is posted, never shown. */
  dealKey: string;
  name: string;
  onClose: () => void;
  /** The dismissal's restore reference, or null when nothing new was written. */
  onDone: (reference: string | null) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
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
    const outcome = await postDismissal(dealKey);
    submittingRef.current = false;
    setSubmitting(false);
    if (outcome.done) onDone(outcome.reference);
    else setError(outcome.error);
  }, [dealKey, onDone]);

  const title = `Dismiss ${name}`;
  const isCandidate = dealKey.startsWith('c:');

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
        className="w-full max-w-[440px] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)] shadow-[var(--shadow-ambient)]"
      >
        <p className="eyebrow">Model proposal</p>
        <h2 className="mt-1 text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">{title}</h2>
        <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          The proposal stays on record and leaves your list. If the model proposes this deal again from later mail, it
          shows again.
        </p>
        <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {isCandidate
            ? 'The proposed deal the codename rules found stays as it is.'
            : 'The codename rules still find deals in this mail.'}
        </p>

        {error ? (
          <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            {error}
          </p>
        ) : null}

        <div className="mt-[var(--space-4)] flex items-center justify-start gap-[var(--space-2)]">
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--accent-contrast)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Dismiss proposal
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

export default DismissProposalDialog;
