'use client';

import * as React from 'react';

import type { CandidateItem } from '@/lib/discovery/api';
import { reasonDate } from '@/lib/discovery/reason';

import { CorrectionDialog, FIELD_CLASS } from './CorrectionDialog';

/**
 * Split some of this proposed deal's emails onto a new proposed deal. The chosen
 * emails move with their evidence; the rest stay. A split that moves every email
 * is a rename, so at least one must stay behind. A re-run leaves both deals as
 * they are.
 */
export function itemDate(sentAt: string | null): string {
  return sentAt && /^\d{4}-\d{2}-\d{2}/.test(sentAt) ? reasonDate(sentAt.slice(0, 10)) : 'undated';
}

export function SplitDialog({
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
  const [chosen, setChosen] = React.useState<ReadonlySet<string>>(new Set());
  const [newName, setNewName] = React.useState('');
  const trimmed = newName.trim();
  const movesAll = chosen.size === items.length;

  const toggle = React.useCallback((sourceItemId: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(sourceItemId)) next.delete(sourceItemId);
      else next.add(sourceItemId);
      return next;
    });
  }, []);

  const buildBody = React.useCallback(
    (reason: string) => ({ itemIds: [...chosen], name: trimmed, reason }),
    [chosen, trimmed],
  );

  return (
    <CorrectionDialog
      candidateId={candidateId}
      route="split"
      eyebrow="Split · logged"
      title={`Split ${name}`}
      submitLabel="Split"
      reasonPlaceholder="Why these emails are a different deal."
      ready={chosen.size > 0 && !movesAll && trimmed.length > 0 && trimmed.length <= 120}
      buildBody={buildBody}
      onClose={onClose}
      onDone={onDone}
    >
      <fieldset className="mt-[var(--space-3)] min-w-0 border-0 p-0">
        <legend className="bank-label">Emails to move</legend>
        <ul className="mt-1 flex max-h-[220px] list-none flex-col gap-[var(--space-1)] overflow-y-auto p-0">
          {items.map((item) => (
            <li key={item.linkId}>
              <label className="flex items-start gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]">
                <input
                  type="checkbox"
                  checked={chosen.has(item.sourceItemId)}
                  onChange={() => toggle(item.sourceItemId)}
                  className="mt-[3px]"
                />
                <span>
                  {item.own ? item.subject || 'No subject' : "From another banker's mailbox"}{' '}
                  <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                    {itemDate(item.sentAt)}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {movesAll ? (
          <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            Leave at least one email on {name}.
          </p>
        ) : null}
      </fieldset>
      <label className="mt-[var(--space-3)] block">
        <span className="bank-label">Name of the new deal</span>
        <input
          aria-label="Name of the new deal"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={120}
          className={FIELD_CLASS}
        />
      </label>
    </CorrectionDialog>
  );
}

export default SplitDialog;
