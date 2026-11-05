'use client';

import * as React from 'react';

import type { CandidateItem, CandidateSummary } from '@/lib/discovery/api';

import { CorrectionDialog, FIELD_CLASS } from './CorrectionDialog';
import { itemDate } from './SplitDialog';
import { useOtherCandidates } from './useOtherCandidates';

/**
 * Move one email from this proposed deal to another of the caller's proposed
 * deals. The email's evidence follows it, and a re-run leaves it where the MD put it.
 */
export function ReassignDialog({
  candidateId,
  name,
  items,
  onClose,
  onDone,
}: {
  candidateId: string;
  name: string;
  items: CandidateItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [linkId, setLinkId] = React.useState(items[0]?.linkId ?? '');
  const [targetId, setTargetId] = React.useState('');
  const options = useOtherCandidates(
    candidateId,
    React.useCallback((others: CandidateSummary[]) => setTargetId(others[0]?.id ?? ''), []),
  );
  const buildBody = React.useCallback(
    (reason: string) => ({ linkId, targetCandidateId: targetId, reason }),
    [linkId, targetId],
  );

  return (
    <CorrectionDialog
      candidateId={candidateId}
      route="reassign"
      eyebrow="Reassign · logged"
      title={`Move an email out of ${name}`}
      submitLabel="Move email"
      reasonPlaceholder="Why this email belongs to the other deal."
      ready={options.status === 'ready' && targetId !== '' && linkId !== ''}
      buildBody={buildBody}
      onClose={onClose}
      onDone={onDone}
    >
      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Email</span>
        <select aria-label="Email" value={linkId} onChange={(e) => setLinkId(e.target.value)} className={FIELD_CLASS}>
          {items.map((item) => (
            <option key={item.linkId} value={item.linkId}>
              {item.own ? item.subject || 'No subject' : "From another banker's mailbox"} · {itemDate(item.sentAt)}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Move to</span>
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
            No other proposed deal to move an email to.
          </p>
        ) : (
          <select
            aria-label="Move to"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
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

export default ReassignDialog;
