'use client';
import * as React from 'react';
import { Button } from '@/components/atoms';
import { Dialog } from '@/components/overlay';

/**
 * Send friction (Issue #95, D105): the firm asks for one confirm step before
 * any send that reaches outside it. Lists who is outside; nothing has been
 * screened or recorded yet when it opens. Keep it mounted and toggle `open`
 * so the exit plays; `recipients` should be retained by the parent while it
 * closes. While a send is in flight, Escape and the close button do nothing.
 */
export function ExternalSendConfirmDialog({
  open,
  recipients,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  recipients: readonly string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      title="Confirm external send"
      size="lg"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            Back to editing
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            Confirm and send
          </Button>
        </>
      }
    >
      <div className="font-sans text-[var(--ink)]">
        <p className="mb-3 text-[length:var(--text-sm)]">
          Your firm confirms every email that leaves it.{' '}
          {recipients.length === 1 ? 'This recipient is' : `These ${recipients.length} recipients are`} outside the firm:
        </p>
        <ul className="mb-3 flex flex-col gap-1 font-mono text-[length:var(--text-sm)]">
          {recipients.map((email) => (
            <li key={email}>{email}</li>
          ))}
        </ul>
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          Your confirmation is recorded with the send. The compliance screen still reviews the message.
        </p>
      </div>
    </Dialog>
  );
}
