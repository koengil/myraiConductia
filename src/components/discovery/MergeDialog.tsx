'use client';

import * as React from 'react';

import type { CandidateSummary } from '@/lib/discovery/api';

import { CorrectionDialog, FIELD_CLASS } from './CorrectionDialog';
import { useOtherCandidates } from './useOtherCandidates';

/**
 * Merge this proposed deal into another of the caller's proposed deals (the
 * survivor). The survivor gains this deal's evidence and keeps its own name; a
 * re-run lands this deal's new mail on it.
 */
export function MergeDialog({
  candidateId,
  name,
  onClose,
  onDone,
}: {
  candidateId: string;
  name: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [survivorId, setSurvivorId] = React.useState('');
  const options = useOtherCandidates(
    candidateId,
    React.useCallback((others: CandidateSummary[]) => setSurvivorId(others[0]?.id ?? ''), []),
  );

  const buildBody = React.useCallback((reason: string) => ({ survivorId, reason }), [survivorId]);

  return (
    <CorrectionDialog
      candidateId={candidateId}
      route="merge"
      eyebrow="Merge · logged"
      title={`Merge ${name} into another deal`}
      submitLabel="Merge"
      reasonPlaceholder="Why these are the same deal."
      ready={options.status === 'ready' && survivorId !== ''}
      buildBody={buildBody}
      onClose={onClose}
      onDone={onDone}
    >
      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Merge into</span>
        {options.status === 'loading' ? (
          <p role="status" className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
            Loading your proposed deals
          </p>
        ) : options.status === 'error' ? (
          <p role="alert" className="mt-1 text-[length:var(--text-sm)] text-[var(--negative-deep)]">
            Your proposed deals could not be loaded. Try again shortly.
          </p>
        ) : options.candidates.length === 0 ? (
          <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            No other proposed deal to merge into.
          </p>
        ) : (
          <select
            aria-label="Merge into"
            value={survivorId}
            onChange={(e) => setSurvivorId(e.target.value)}
            className={FIELD_CLASS}
          >
            {options.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </label>
    </CorrectionDialog>
  );
}

export default MergeDialog;
