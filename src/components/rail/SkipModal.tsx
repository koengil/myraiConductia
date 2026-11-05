'use client';

import * as React from 'react';

import { stepTitle, type ProjectRailStep, type SkipStepInput } from '@/lib/rail/projectRail';
import { useSkipApprovers } from '@/lib/rail/useSkipApprovers';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { logAudit } from '@/lib/audit/store';
import { Button } from '@/components/atoms/Button';
import { Dialog } from '@/components/overlay/Dialog';

/**
 * SkipModal — the logged approval gate for skipping a rail step. A skip is
 * never silent: it names an approver, requires a reason, and the reason is
 * recorded on the deal and routes onward to the approver and compliance.
 * On a live deal the approver list is the deal's eligible seats, the people
 * the skip routes accept (#312).
 */
export function SkipModal({
  step,
  stepNumber,
  dealId,
  live = false,
  onConfirm,
  onClose,
}: {
  step: ProjectRailStep;
  stepNumber: number;
  dealId: string;
  /** The skip reaches the server, so the approver must be a seat on this deal. */
  live?: boolean;
  onConfirm: (input: SkipStepInput) => Promise<void>;
  onClose: () => void;
}) {
  const deal = useActiveDeal(dealId);
  const { state: userState } = useCurrentUser();
  const userId = userState.status === 'ready' ? userState.data.user.id : null;
  const { members, status } = useSkipApprovers({ dealId, stepKey: step.stepId, live });
  const defaultApproverId =
    members.length === 0
      ? ''
      : (userId ? members.find((member) => member.id === userId)?.id : null) ?? members[0]?.id ?? '';
  const [approverId, setApproverId] = React.useState(defaultApproverId);
  const [prevDefaultApproverId, setPrevDefaultApproverId] = React.useState(defaultApproverId);
  if (defaultApproverId !== prevDefaultApproverId) {
    setPrevDefaultApproverId(defaultApproverId);
    setApproverId((prev) =>
      prev && members.some((member) => member.id === prev) ? prev : defaultApproverId,
    );
  }
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const submittingRef = React.useRef(false);
  const [submitting, setSubmitting] = React.useState(false);

  const approver = members.find((m) => m.id === approverId) ?? members[0];
  const canConfirm = reason.trim().length > 0 && approver != null;

  const handleConfirm = React.useCallback(async () => {
    if (!approver || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm({ approverId: approver.id, approverName: approver.name, reason: reason.trim() });
      logAudit('step', 'Skipped', stepTitle(step), {
        deal: deal.codename,
        detail: `Approved by ${approver.name} · ${reason.trim()}`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That step could not be skipped.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [approver, step, reason, deal.codename, onConfirm]);

  // Typed input lives here, so a stray scrim click must not discard it.
  // Mounted only while a skip target exists (it loads approvers), so it gets
  // the enter motion only. ariaLabel keeps the name "Skip <step>" that
  // e2e/steps/skipStepAtCursor.ts and the rail tests find the dialog by. It can
  // go once they find it by its title, "Skip NN · <step>".
  return (
    <Dialog
      open
      onClose={onClose}
      dismissOnScrim={false}
      ariaLabel={`Skip ${stepTitle(step)}`}
      eyebrow="Skip step · logged"
      title={`Skip ${String(stepNumber).padStart(2, '0')} · ${stepTitle(step)}`}
      description="A skip needs an approver and a reason. Both are logged on the deal record. The reason routes onward to the approver and compliance."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canConfirm || submitting} onClick={handleConfirm}>
            Skip step
          </Button>
        </>
      }
    >
      <label className="mt-[var(--space-1)] block">
        <span className="bank-label">Approved by</span>
        {status === 'loading' ? (
          <div
            className="mt-1 flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]"
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin rounded-full border-2 border-[var(--stroke)] border-t-[var(--accent)]"
            />
            Loading approvers…
          </div>
        ) : status === 'error' ? (
          <p className="mt-1 text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            Could not load approvers. Try again shortly.
          </p>
        ) : members.length === 0 ? (
          <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            No eligible approver on this deal.
          </p>
        ) : (
          <select
            value={approverId}
            onChange={(e) => setApproverId(e.target.value)}
            className="mt-1 w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.role}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Reason</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Why this step does not apply on this deal."
          className="mt-1 w-full resize-none rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] placeholder:text-[var(--ink-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </label>

      {error ? (
        <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export default SkipModal;
