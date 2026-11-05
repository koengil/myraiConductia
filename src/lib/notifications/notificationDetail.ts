import { TEAM_MAILBOX_CHECK_REASON, type TeamMailboxCheckReason } from '@/lib/constants/discovery';
import { NOTIFICATION_EVENT } from '@/lib/constants/notifications';

import type { AppNotification } from './useNotifications';

/**
 * The second line of a notification in the bell (#173 G-04). Two kinds read
 * from their own payload; every other kind keeps the bell's chain: the
 * destination label, then the deal's codename (never its code), then the
 * address.
 *
 * COMPLIANCE: the team refusal payload carries the inbox address and one fixed
 * check code, never mail; the drift payload carries counts only.
 */

/** One short phrase per Directory refusal reason (design to confirm). */
export const TEAM_REFUSAL_SHORT: Record<TeamMailboxCheckReason, string> = {
  [TEAM_MAILBOX_CHECK_REASON.GROUP]: 'Google Group, not a mailbox',
  [TEAM_MAILBOX_CHECK_REASON.ALIAS]: 'Alias, not the primary address',
  [TEAM_MAILBOX_CHECK_REASON.SUSPENDED]: 'Account suspended',
  [TEAM_MAILBOX_CHECK_REASON.NO_MAILBOX]: 'No mailbox yet',
  [TEAM_MAILBOX_CHECK_REASON.NOT_FOUND]: 'Not found in Workspace',
  [TEAM_MAILBOX_CHECK_REASON.IDENTITY_CHANGED]: 'Address moved to another account',
  [TEAM_MAILBOX_CHECK_REASON.DIRECTORY_DENIED]: 'Directory read not granted',
};

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function notificationDetail(item: AppNotification): string {
  const payload: AppNotification['payload'] = item.payload ?? {};

  if (item.event_type === NOTIFICATION_EVENT.TEAM_MAILBOX_REFUSED) {
    const reason = text(payload.reason);
    const short = reason ? ((TEAM_REFUSAL_SHORT as Record<string, string>)[reason] ?? null) : null;
    return [text(payload.address), short].filter(Boolean).join(' · ') || 'A team inbox';
  }

  if (item.event_type === NOTIFICATION_EVENT.MAILBOX_ALLOWLIST_DRIFT) {
    if (payload.status === 'unavailable') return 'Provider group could not be read';
    return `${count(payload.missingCount)} missing, ${count(payload.extraCount)} extra`;
  }

  // The deal by its codename, never its code (the code is for the link).
  const destinationLabel = typeof payload.destinationLabel === 'string' ? payload.destinationLabel : null;
  return destinationLabel ?? payload.codename ?? payload.address ?? 'a deal';
}
