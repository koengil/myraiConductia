// Gate 0 invite queue — the pure chip state machine behind the Team step's
// "Invite by email" affordance. The deal does not exist until the wizard's
// final create succeeds, so invitations queue locally as chips and fire against
// POST /api/v1/invites only after the create returns the deal id. This module
// holds the queue transitions with zero React so they unit-test without
// mounting the wizard.
//
// Chip lifecycle: queued -> creating -> sent | access-granted | access-existing |
// created-email-failed | failed.
// - sent:                 201 and the email delivered (deliveryStatus 'sent').
// - created-email-failed: the invite ROW exists but the email did not go out
//                         (201 with deliveryStatus 'unsent', or a 409
//                         duplicate_pending that disclosed the pending invite
//                         id). Recovery is POST /api/v1/invites/{id}/resend.
// - failed:               nothing usable exists client-side (network, 5xx, or
//                         an opaque 409/4xx). Recovery is re-POSTing the same
//                         create; the server dedupes by pending email.

import { DEAL_ROLE } from '@/lib/constants/roles';

/** Internal (bank-side) deal roles an email invite may carry at Gate 0.
 *  External buyer and seller invitations happen after the deal exists, from
 *  Team — never from this wizard. Mirrors the server's
 *  INTERNAL_INVITE_DEAL_ROLES allowlist in /api/v1/invites. */
export const INVITE_DEAL_ROLES = [
  DEAL_ROLE.DEAL_TEAM,
  DEAL_ROLE.LEGAL,
  DEAL_ROLE.READ_ONLY,
] as const;

export type InviteDealRole = (typeof INVITE_DEAL_ROLES)[number];

export type InviteChipState =
  | 'queued'
  | 'creating'
  | 'sent'
  | 'access-granted'
  | 'access-existing'
  | 'created-email-failed'
  | 'failed';

export type InviteChip = {
  /** Normalized (trimmed, lowercased) — the queue's identity key. */
  email: string;
  role: InviteDealRole;
  state: InviteChipState;
  /** Present once the server disclosed an invite row (201, or 409 with id). */
  inviteId?: string;
  /** MD-facing failure detail, when the server gave one. */
  error?: string;
  /** Explicit company/domain decision captured before the immutable chip is queued. */
  domainConfirmation?: {
    id: string;
    classification: 'mismatch' | 'personal' | 'unverified';
    expiresAt: string;
  };
};

/** Short chip-status labels for the wizard UI. */
export const INVITE_STATE_LABELS: Record<InviteChipState, string> = {
  queued: 'Queued',
  creating: 'Sending',
  sent: 'Sent',
  'access-granted': 'Access granted',
  'access-existing': 'Already has access',
  'created-email-failed': 'Email failed',
  failed: 'Failed',
};

/** Normalize the way the server does (trim + lowercase) so client-side
 *  duplicate rejection matches the server's pending-email dedupe. */
export function normalizeInviteEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Mirrors the server's email shape check in POST /api/v1/invites. */
export function isValidInviteEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export type AddInviteResult =
  | { ok: true; queue: InviteChip[] }
  | { ok: false; error: string };

/** Queue a new invitation chip. Rejects malformed emails and duplicates
 *  already in the queue (case-insensitive). */
export function addInvite(
  queue: readonly InviteChip[],
  rawEmail: string,
  role: InviteDealRole,
  domainConfirmation?: InviteChip['domainConfirmation'],
): AddInviteResult {
  const email = normalizeInviteEmail(rawEmail);
  if (!isValidInviteEmail(email)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  if (queue.some((chip) => chip.email === email)) {
    return { ok: false, error: 'That email is already queued.' };
  }
  return {
    ok: true,
    queue: [
      ...queue,
      {
        email,
        role,
        state: 'queued',
        ...(domainConfirmation ? { domainConfirmation } : {}),
      },
    ],
  };
}

/** Remove a chip before create. Only queued chips are removable; once the
 *  create fires the chip is a delivery record, not a draft. */
export function removeInvite(
  queue: readonly InviteChip[],
  email: string,
): InviteChip[] {
  return queue.filter(
    (chip) => !(chip.email === email && chip.state === 'queued'),
  );
}

/** Mark one chip in flight (its POST /api/v1/invites is running). */
export function markCreating(
  queue: readonly InviteChip[],
  email: string,
): InviteChip[] {
  return queue.map((chip) =>
    chip.email === email ? { ...chip, state: 'creating', error: undefined } : chip,
  );
}

/** Outcome of one POST /api/v1/invites, pre-digested by the caller:
 *  - created:   201 -> invite.id + invite.deliveryStatus ('sent' | 'unsent').
 *  - existing:  200 -> an existing account was added (or already had a seat).
 *  - duplicate: 409 duplicate_pending; inviteId present only when the server
 *               disclosed the existing pending invite.
 *  - error:     network failure, 5xx, or any other 4xx (message when given). */
export type InviteCreateResult =
  | {
      kind: 'created';
      inviteId: string;
      deliveryStatus: 'sent' | 'unsent';
    }
  | { kind: 'existing'; accessGranted: boolean }
  | { kind: 'duplicate'; inviteId?: string }
  | { kind: 'error'; message?: string };

export function applyCreateResult(
  queue: readonly InviteChip[],
  email: string,
  result: InviteCreateResult,
): InviteChip[] {
  return queue.map((chip) => {
    if (chip.email !== email) return chip;
    switch (result.kind) {
      case 'created':
        return result.deliveryStatus === 'sent'
          ? {
              ...chip,
              state: 'sent',
              inviteId: result.inviteId,
              error: undefined,
            }
          : {
              ...chip,
              state: 'created-email-failed',
              inviteId: result.inviteId,
              error: undefined,
            };
      case 'duplicate':
        // A disclosed pending invite already exists for this email: treat it
        // as created and offer resend. An opaque 409 gives nothing to resend,
        // so it stays a plain failure (re-create is safe; the server dedupes).
        return result.inviteId
          ? {
              ...chip,
              state: 'created-email-failed',
              inviteId: result.inviteId,
              error: undefined,
            }
          : {
              ...chip,
              state: 'failed',
              error: 'An invitation for this email is already pending.',
            };
      case 'existing':
        return {
          ...chip,
          state: result.accessGranted ? 'access-granted' : 'access-existing',
          error: undefined,
        };
      case 'error':
        return { ...chip, state: 'failed', error: result.message };
    }
  });
}

/** Outcome of one POST /api/v1/invites/{id}/resend. */
export type InviteResendResult = {
  ok: boolean;
  deliveryStatus?: 'sent' | 'unsent';
  error?: string;
};

export function applyResendResult(
  queue: readonly InviteChip[],
  email: string,
  result: InviteResendResult,
): InviteChip[] {
  return queue.map((chip) => {
    if (chip.email !== email) return chip;
    if (result.ok && result.deliveryStatus === 'sent') {
      return { ...chip, state: 'sent', error: undefined };
    }
    // The invite row still exists; only delivery keeps failing. Stay
    // created-email-failed so resend remains the retry path.
    return { ...chip, state: 'created-email-failed' };
  });
}

export type InviteRetryAction =
  | { type: 'none' }
  | { type: 'create' }
  | { type: 'resend'; inviteId: string };

/** The recovery move per chip state: failed -> re-POST the create (the server
 *  dedupes by pending email); created-email-failed with a known invite id ->
 *  resend that invite. Everything else has no retry. */
export function retryActionFor(chip: InviteChip): InviteRetryAction {
  if (chip.state === 'failed') return { type: 'create' };
  if (chip.state === 'created-email-failed' && chip.inviteId) {
    return { type: 'resend', inviteId: chip.inviteId };
  }
  return { type: 'none' };
}

/** Honest one-line delivery summary for the post-create receipt. The mandate
 *  creation itself is never reported through this line; it covers delivery
 *  only. Null when nothing was queued. */
export function summarizeInviteOutcomes(
  outcomes: ReadonlyArray<{ state: InviteChipState }>,
): string | null {
  if (outcomes.length === 0) return null;
  const deliveryOutcomes = outcomes.filter(
    (o) => o.state !== 'access-granted' && o.state !== 'access-existing',
  );
  if (deliveryOutcomes.length === 0) return null;
  const sent = deliveryOutcomes.filter((o) => o.state === 'sent').length;
  const failed = deliveryOutcomes.length - sent;
  const sentPart = `${sent} invitation${sent === 1 ? '' : 's'} sent`;
  if (failed === 0) return `${sentPart}.`;
  return `${sentPart}, ${failed} failed. Retry from the deal's Team.`;
}
