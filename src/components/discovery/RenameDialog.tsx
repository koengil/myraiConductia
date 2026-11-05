'use client';

import * as React from 'react';

import { CorrectionDialog, FIELD_CLASS } from './CorrectionDialog';

/** Rename a proposed deal. The name is pinned: a re-run never renames it back. */
export function RenameDialog({
  candidateId,
  currentName,
  onClose,
  onDone,
}: {
  candidateId: string;
  currentName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = React.useState(currentName);
  const trimmed = name.trim();
  const buildBody = React.useCallback(
    (reason: string) => ({ name: trimmed, ...(reason ? { reason } : {}) }),
    [trimmed],
  );
  return (
    <CorrectionDialog
      candidateId={candidateId}
      route="rename"
      eyebrow="Rename · logged"
      title="Rename this proposed deal"
      submitLabel="Rename"
      reasonRequired={false}
      reasonPlaceholder="Why the name changes."
      ready={trimmed.length > 0 && trimmed.length <= 120 && trimmed !== currentName}
      buildBody={buildBody}
      onClose={onClose}
      onDone={onDone}
    >
      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={FIELD_CLASS} />
      </label>
    </CorrectionDialog>
  );
}

export default RenameDialog;
