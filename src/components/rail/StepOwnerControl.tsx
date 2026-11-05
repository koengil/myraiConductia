'use client';

import * as React from 'react';

import { Button } from '@/components/atoms/Button';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { AssignStepDialog, type AssignedStep } from './AssignStepDialog';

/** Step detail when the step read failed. */
export const OWNER_FAILED_COPY = 'Owner could not be loaded.';

/**
 * Who owns a step, in step detail. The MD changes it the same deliberate way
 * as on the board: "Assign…" opens the dialog that says who gets notified,
 * then the existing steps PATCH. Everyone else reads the name only.
 */
export function StepOwnerControl({
  dealId,
  stepId,
  title,
  assignedToName,
  canAssign,
  disabled = false,
  loadFailed = false,
  onRetry,
  onAssigned,
}: {
  dealId: string;
  stepId: string;
  /** The step's name, for the dialog title. */
  title: string;
  assignedToName: string | null;
  canAssign: boolean;
  /** A closed step keeps its owner: the MD reads it but cannot change it. */
  disabled?: boolean;
  /** The step read failed: the owner is unknown, so say so (never "Unassigned"). */
  loadFailed?: boolean;
  onRetry?: () => void;
  onAssigned: (step?: AssignedStep) => void;
}) {
  if (loadFailed) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-[var(--space-2)]">
        <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{OWNER_FAILED_COPY}</p>
        {onRetry ? (
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  if (!canAssign && !assignedToName) return null;
  return (
    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {assignedToName ? `Assigned to ${assignedToName}` : 'Unassigned'}
      </p>
      {canAssign && !disabled ? (
        <AssignButton dealId={dealId} stepId={stepId} title={title} onAssigned={onAssigned} />
      ) : null}
    </div>
  );
}

/** Only the MD gets this, so only the MD's panel reads who they are. */
function AssignButton({
  dealId,
  stepId,
  title,
  onAssigned,
}: {
  dealId: string;
  stepId: string;
  title: string;
  onAssigned: (step?: AssignedStep) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const { state: userState } = useCurrentUser();
  const meId = userState.status === 'ready' ? (userState.data.user?.id ?? null) : null;
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Assign…
      </Button>
      <AssignStepDialog
        dealId={dealId}
        step={open ? { stepId, title } : null}
        currentUserId={meId}
        onClose={() => setOpen(false)}
        onAssigned={onAssigned}
      />
    </>
  );
}

export default StepOwnerControl;
