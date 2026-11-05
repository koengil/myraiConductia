'use client';

import * as React from 'react';

import { STEP_STATUS } from '@/lib/constants/dealSteps';
import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';

/** Why a step cannot be removed, or null when it can. */
export function removalBlockedReason(step: ProjectRailStep): string | null {
  if (PROTECTED_STEP_IDS.has(step.stepId)) return 'This step is required and cannot be removed.';
  if (step.status === STEP_STATUS.COMPLETE) return 'This step is completed and cannot be removed.';
  return null;
}

/** The two refusals the remove route names (409); every other failure reads plainly. */
const NAMED_REMOVE_REFUSALS: Record<string, string> = {
  'A completed step cannot be removed': 'A completed step cannot be removed.',
  'This step is required and cannot be removed': 'This step is required and cannot be removed.',
};
export const REMOVE_FAILED_COPY = 'The step was not removed. Try again.';
export const REMOVE_OFFLINE_COPY = 'This step could not be removed. Check your connection and try again.';

/**
 * The one remove request for a deal step: confirms once, calls the existing
 * DELETE, and reports the server's refusal. Shared by the zoomed step's inline
 * control and the board card menu's confirmation dialog.
 */
export function useRemoveStep(projectId: string, step: ProjectRailStep, onRemoved: () => void) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const removingRef = React.useRef(false);
  const remove = React.useCallback(async (): Promise<boolean> => {
    if (removingRef.current) return false;
    removingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/deals/${encodeURIComponent(projectId)}/rail/steps/${encodeURIComponent(step.id)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const named = res.status === 409 && body.error ? NAMED_REMOVE_REFUSALS[body.error] : undefined;
        // The server's own text goes to the console, never the screen.
        if (!named && body.error) console.error('[rail] remove step refused', res.status, body.error);
        setError(named ?? REMOVE_FAILED_COPY);
        return false;
      }
      onRemoved();
      return true;
    } catch {
      // A network failure: say so, and never leave an unhandled rejection.
      setError(REMOVE_OFFLINE_COPY);
      return false;
    } finally {
      removingRef.current = false;
      setPending(false);
    }
  }, [projectId, step.id, onRemoved]);
  const clearError = React.useCallback(() => setError(null), []);
  return { remove, pending, error, clearError };
}

export function RemoveStepControl({
  projectId,
  step,
  canRemove,
  onRemoved,
  confirmOverlayClassName,
  tabIndex,
}: {
  projectId: string;
  step: ProjectRailStep;
  canRemove: boolean;
  onRemoved: () => void;
  confirmOverlayClassName?: string;
  /** -1 on a board card that is not its column's tab stop. */
  tabIndex?: number;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const { remove, pending, error } = useRemoveStep(projectId, step, onRemoved);
  const reasonId = React.useId();

  const reason = removalBlockedReason(step);
  const disabled = reason !== null;

  const handleConfirm = React.useCallback(async () => {
    if (await remove()) setConfirming(false);
  }, [remove]);

  if (!canRemove) return null;

  const trigger = (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      tabIndex={tabIndex}
      disabled={disabled}
      title={reason ?? undefined}
      aria-describedby={reason && !confirming ? reasonId : undefined}
      className="self-start rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-2)] py-1 text-[length:var(--text-xxs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50"
    >
      Remove
    </button>
  );

  if (confirming) {
    const confirmation = (
      <div
        className={['flex flex-col gap-[var(--space-2)]', confirmOverlayClassName ?? ''].join(' ')}
      >
        <p className="text-[length:var(--text-xxs)] text-[var(--ink-secondary)]">
          {stepTitle(step)} moves out of the active rail. Its work, history and artifacts stay in
          the record and it can be restored.
        </p>
        {error ? (
          <p className="text-[length:var(--text-xxs)] text-[var(--negative-deep)]">{error}</p>
        ) : null}
        <div className="flex items-center gap-[var(--space-2)]">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={pending}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-2)] py-1 text-[length:var(--text-xxs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={pending}
            className="rounded-[var(--radius-button)] bg-[var(--negative-deep)] px-[var(--space-2)] py-1 text-[length:var(--text-xxs)] font-medium text-[var(--ink-on-dark)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Remove step
          </button>
        </div>
      </div>
    );

    if (!confirmOverlayClassName) return confirmation;

    return (
      <>
        <div className="invisible flex flex-col">{trigger}</div>
        {confirmation}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {trigger}
      {reason ? (
        <p id={reasonId} className="text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">{reason}</p>
      ) : null}
    </div>
  );
}

export default RemoveStepControl;
