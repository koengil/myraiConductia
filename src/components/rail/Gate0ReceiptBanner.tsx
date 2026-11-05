'use client';

import * as React from 'react';

import { subscribeGeneration } from '@/lib/api/inflightRead';
import { takeGate0Receipt, type Gate0Receipt } from '@/lib/deals/gate0Receipt';
import { storeOwner } from '@/lib/session/storeOwner';
import { summarizeInviteOutcomes } from '@/components/wizard/inviteQueue';
import { formatDateTime } from '@/lib/format/date';

/**
 * The honest Gate 0 create receipt, shown once on the rail landing (?new=1).
 * Reads the receipt the wizard stashed for this deal code and renders only what
 * actually ran: the MNPI screen verdict and the notification log (how many
 * recipients, when). No fabricated KYC/FINRA. One-shot: reading clears it, so a
 * refresh does not re-show it.
 */

const VERDICT_COPY: Record<Gate0Receipt['verdict'], { label: string; tone: string }> = {
  compliant: { label: 'Compliant', tone: 'var(--positive-deep)' },
  hold: { label: 'Held for review', tone: 'var(--warning-deep)' },
  blocked: { label: 'Blocked', tone: 'var(--negative-deep)' },
};

export function Gate0ReceiptBanner({ code, active }: { code: string; active: boolean }) {
  // The receipt is stamped with its creator (#162): it is taken once the
  // owner is known, and shown only while that owner is still signed in.
  const owner = React.useSyncExternalStore(subscribeGeneration, storeOwner, () => null);
  const [taken, setTaken] = React.useState<{ owner: string; receipt: Gate0Receipt | null } | null>(
    null,
  );

  React.useEffect(() => {
    if (!active || owner === null) return;
    // Deferred read (past commit) — sessionStorage is client-only and this is a
    // one-shot take (clears on read).
    const raf = window.requestAnimationFrame(() =>
      setTaken({ owner, receipt: takeGate0Receipt(code) }),
    );
    return () => window.cancelAnimationFrame(raf);
  }, [active, code, owner]);

  const receipt = taken?.owner === owner ? taken.receipt : null;
  if (!receipt) return null;

  const inviteSummary = receipt.invites ? summarizeInviteOutcomes(receipt.invites) : null;
  const accessGrants = receipt.invites?.filter((invite) => invite.state === 'access-granted') ?? [];
  const existingAccess = receipt.invites?.filter((invite) => invite.state === 'access-existing') ?? [];
  const deliveryFailures = receipt.invites?.filter(
    (invite) =>
      invite.state !== 'sent' &&
      invite.state !== 'access-granted' &&
      invite.state !== 'access-existing',
  ) ?? [];

  const verdict = VERDICT_COPY[receipt.verdict];
  const when = receipt.at
    ? formatDateTime(receipt.at)
    : null;

  return (
    <div
      role="status"
      // Named so a browser journey can scope its assertion to this receipt
      // rather than to any status node on the rail. The banner reports invite
      // outcomes as one summary sentence and lists addresses only for
      // failures, so the region, not a per-chip node, is the addressable unit.
      aria-label="Mandate opened"
      className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-raised)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex flex-col gap-1">
        <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {receipt.origin === 'discovery' ? 'Mandate opened from discovery' : 'Mandate opened'}
        </p>
        <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
          MNPI screen:{' '}
          <span style={{ color: verdict.tone }} className="font-semibold">
            {verdict.label}
          </span>
          {receipt.recipients > 0 ? (
            <>
              {' · '}
              {receipt.recipients} compliance recipient
              {receipt.recipients === 1 ? '' : 's'} notified
              {when ? ` · ${when}` : ''}
            </>
          ) : (
            ' · no recipients configured'
          )}
        </p>
        {receipt.invites && receipt.invites.length > 0 ? (
          <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
            {inviteSummary}
            {accessGrants.length > 0 ? (
              <>
                {inviteSummary ? ' ' : ''}
                {accessGrants.length} existing account{accessGrants.length === 1 ? '' : 's'} granted access.
              </>
            ) : null}
            {existingAccess.length > 0 ? (
              <>
                {(inviteSummary || accessGrants.length > 0) ? ' ' : ''}
                {existingAccess.length} existing account{existingAccess.length === 1 ? '' : 's'} already had access.
              </>
            ) : null}
            {deliveryFailures.length > 0 ? (
              <span className="ml-2 font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {deliveryFailures
                  .map((i) => i.email)
                  .join(' · ')}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setTaken(null)}
        className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-1 text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors hover:text-[var(--ink)]"
      >
        Dismiss
      </button>
    </div>
  );
}

export default Gate0ReceiptBanner;
