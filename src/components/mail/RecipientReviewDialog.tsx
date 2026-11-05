'use client';
import * as React from 'react';
import { Button } from '@/components/atoms';
import { Dialog } from '@/components/overlay';
import { becomesKnownRecipient, type RecipientDecision, type RecipientField } from '@/lib/mail/recipientReview';
import { RecipientRelationshipList } from './RecipientRelationshipList';

function approveLabel(knownAdditions: number): string {
  if (knownAdditions > 1) return 'Send anyway and add as known recipients';
  if (knownAdditions === 1) return 'Send anyway and add as known recipient';
  return 'Approve recipients and continue';
}

/**
 * The recipient review before a send (Issue #378). Keep it mounted and toggle
 * `open` so the exit plays; the parent retains `recipients` while it closes.
 * While a send is in flight, Escape, the close button and Remove do nothing.
 * `onCancel` says how it closed, so the composer puts focus back on purpose:
 * 'dismiss' (Escape, Close) or 'edit' (Back to editing).
 */
export function RecipientReviewDialog({
  open,
  recipients,
  busy,
  onRemove,
  onApprove,
  onCancel,
}: {
  open: boolean;
  recipients: readonly RecipientDecision[];
  busy: boolean;
  onRemove: (field: RecipientField, email: string) => void;
  onApprove: () => void;
  onCancel: (how: 'dismiss' | 'edit') => void;
}) {
  const knownAdditions = Array.from(new Set(recipients.filter(becomesKnownRecipient).map((r) => r.email)));
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onCancel('dismiss');
      }}
      title="Review email recipients"
      size="lg"
      dismissOnScrim={false}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => onCancel('edit')}>
            Back to editing
          </Button>
          <Button disabled={busy} onClick={onApprove}>
            {approveLabel(knownAdditions.length)}
          </Button>
        </>
      }
    >
      <div className="font-sans text-[length:var(--text-sm)] text-[var(--ink)]">
        {recipients.some((r) => r.requiresConfirmation && r.reason === 'not_on_deal' && r.boundary === 'external') ? (
          <p className="mb-3 text-[var(--negative-deep)]">EXTERNAL NON-DEAL ASSOCIATED PARTY COPIED ON THIS EMAIL. PLEASE APPROVE.</p>
        ) : null}
        {recipients.some((r) => r.reason === 'counterparty') ? (
          <p className="mb-3 text-[var(--negative-deep)]">Counterparty and/or Counterparty Advisor copied on this email, please approve.</p>
        ) : null}
        {recipients.some(
          (r) => r.requiresConfirmation && r.reason !== 'counterparty' && !(r.reason === 'not_on_deal' && r.boundary === 'external'),
        ) ? (
          <p className="mb-3">
            Some recipients are not on the banking deal team or need their relationship reviewed. Confirm before continuing.
          </p>
        ) : null}
        <RecipientRelationshipList
          recipients={recipients}
          onRemove={(field, email) => {
            if (!busy) onRemove(field, email);
          }}
        />
        {/* Storm's three choices (Issue #378): send and add as a known recipient, remove, or go back. */}
        {knownAdditions.length ? (
          <p className="mt-3 text-[var(--ink-secondary)]">
            Sending adds {knownAdditions.join(', ')} as {knownAdditions.length > 1 ? 'known recipients' : 'a known recipient'}{' '}
            for this project. Later emails on this deal will not ask again.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
