'use client';

import * as React from 'react';

import { CorrectionDialog } from './CorrectionDialog';

/** Reject a proposed deal. It leaves the list and gains no further evidence. */
export function RejectDialog({
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
  const buildBody = React.useCallback((reason: string) => ({ reason }), []);
  return (
    <CorrectionDialog
      candidateId={candidateId}
      route="reject"
      eyebrow="Reject · logged"
      title={`Reject ${name}`}
      submitLabel="Reject"
      reasonPlaceholder="Why this is not a deal."
      buildBody={buildBody}
      onClose={onClose}
      onDone={onDone}
    >
      <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        A rejected proposed deal leaves the list and takes no further mail. The decision and its reason stay in the history.
      </p>
    </CorrectionDialog>
  );
}

export default RejectDialog;
