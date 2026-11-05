'use client';

import * as React from 'react';

import { Dialog } from '@/components/overlay';

/**
 * The shell of the correction dialogs (rename, step, merge, reject, split, reassign):
 * the shared Dialog (typed reason, so the scrim does not close it), a required reason,
 * and one POST to the candidate's correction route. A correction is never
 * silent: it names who, what and why in the decision history, so the reason box
 * is required wherever the RPC requires one.
 */

export type CorrectionRoute = 'rename' | 'reject' | 'station' | 'merge' | 'split' | 'reassign';

const FIELD =
  'mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
export const FIELD_CLASS = FIELD;

/** POSTs one correction. Resolves with null on success, else the message to show. */
export async function postCorrection(
  candidateId: string,
  route: CorrectionRoute,
  body: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res = await fetch(`/api/v1/discovery/candidates/${encodeURIComponent(candidateId)}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    return payload.error ?? 'The change could not be saved';
  } catch {
    return 'The change could not be saved';
  }
}

export function CorrectionDialog({
  candidateId,
  route,
  eyebrow,
  title,
  submitLabel,
  reasonRequired = true,
  reasonPlaceholder,
  initialReason = '',
  reasonDescribedBy,
  ready = true,
  buildBody,
  onClose,
  onDone,
  children,
}: {
  candidateId: string;
  route: CorrectionRoute;
  eyebrow: string;
  title: string;
  submitLabel: string;
  reasonRequired?: boolean;
  reasonPlaceholder: string;
  /**
   * What the reason box shows until the person types in it. Empty unless the dialog confirms a proposal. It may change
   * while the dialog is open (the step dialog clears it when the person picks a different step): the box follows
   * it as long as the person has not typed, and never overwrites a reason they did.
   */
  initialReason?: string;
  /** The id of text that describes the reason box (aria-describedby). */
  reasonDescribedBy?: string;
  /** False until the dialog's own fields are valid. */
  ready?: boolean;
  buildBody: (reason: string) => Record<string, unknown>;
  onClose: () => void;
  onDone: () => void;
  children?: React.ReactNode;
}) {
  // null until the person types: the box then shows `initialReason`, which the caller may change meanwhile.
  const [typedReason, setTypedReason] = React.useState<string | null>(null);
  const reason = typedReason ?? initialReason;
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);

  const canSubmit = ready && (!reasonRequired || reason.trim().length > 0) && !submitting;

  const submit = React.useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const failure = await postCorrection(candidateId, route, buildBody(reason.trim()));
    submittingRef.current = false;
    setSubmitting(false);
    if (failure) setError(failure);
    else onDone();
  }, [candidateId, route, buildBody, reason, onDone]);

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow={eyebrow}
      title={title}
      dismissOnScrim={false}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </>
      }
    >
      {children}

      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">{reasonRequired ? 'Reason' : 'Reason (optional)'}</span>
        <textarea
          value={reason}
          onChange={(e) => setTypedReason(e.target.value)}
          aria-describedby={reasonDescribedBy}
          rows={3}
          placeholder={reasonPlaceholder}
          className={`${FIELD} resize-none`}
        />
      </label>

      {error ? (
        <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export default CorrectionDialog;
