'use client';

import * as React from 'react';

import { removedSteps, stepTitle, type ProjectRail } from '@/lib/rail/projectRail';
import { restoreStepRequest } from './restoreStepRequest';
import { formatDateTime } from '@/lib/format/date';

function formatRemovedAt(iso: string): string {
  return formatDateTime(iso);
}

function RestoreButton({
  projectId,
  stepId,
  onRestored,
}: {
  projectId: string;
  stepId: string;
  onRestored: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const restoringRef = React.useRef(false);

  const handleClick = React.useCallback(async () => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await restoreStepRequest(projectId, stepId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onRestored();
    } finally {
      restoringRef.current = false;
      setPending(false);
    }
  }, [projectId, stepId, onRestored]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-2)] py-1 text-[length:var(--text-xxs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)] disabled:opacity-50"
      >
        Restore
      </button>
      {error ? (
        <p className="text-[length:var(--text-xxs)] text-[var(--negative-deep)]">{error}</p>
      ) : null}
    </div>
  );
}

export function RemovedStepsSection({
  projectId,
  rail,
  canRestore,
  onRestored,
}: {
  projectId: string;
  rail: ProjectRail;
  canRestore: boolean;
  onRestored: () => void;
}) {
  const removed = removedSteps(rail);
  if (removed.length === 0) return null;

  return (
    <details className="mt-[var(--space-5)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]">
      <summary className="cursor-pointer list-none px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
        Removed steps <span className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">({removed.length})</span>
      </summary>
      <ul className="divide-y divide-[var(--stroke)] border-t border-[var(--stroke)]">
        {removed.map((step) => (
          <li
            key={step.id}
            className="flex items-center justify-between gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)]"
          >
            <div>
              <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                {stepTitle(step)}
              </p>
              <p className="mt-0.5 font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
                {step.removedBy === null
                  ? 'Left out of the saved rail'
                  : `${step.removedAt ? `Removed ${formatRemovedAt(step.removedAt)}` : 'Removed'} by ${step.removedBy.name}`}
              </p>
            </div>
            {canRestore ? (
              <RestoreButton
                projectId={projectId}
                stepId={step.id}
                onRestored={onRestored}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default RemovedStepsSection;
