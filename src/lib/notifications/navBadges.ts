import { NOTIFICATION_EVENT, type NotificationEvent } from '@/lib/constants/notifications';

import { safeAuthDestination } from '@/lib/auth/redirect';
import { organizationSettingsHref, settingsHref } from '@/lib/settings/href';
import type { SettingsSectionId } from '@/lib/settings/types';

import type { AppNotification } from './useNotifications';

/**
 * Nav badge source. Maps the existing notification event types to the nav
 * destination they belong to; unread only. No new notification types: events
 * not listed here (deal_created, expense_approved) badge nothing.
 */
export type NavBadgeDestination = 'mail' | 'team' | 'rails' | 'settings';

export const NOTIFICATION_DESTINATION: Partial<Record<NotificationEvent, NavBadgeDestination>> = {
  [NOTIFICATION_EVENT.MAIL_QUEUED_FOR_REVIEW]: 'mail',
  [NOTIFICATION_EVENT.COMPLIANCE_HOLD]: 'mail',
  [NOTIFICATION_EVENT.MEMBER_ADDED]: 'team',
  // Permission requests are about the firm, not a deal: Settings › Organization.
  [NOTIFICATION_EVENT.ACCESS_REQUESTED]: 'settings',
  [NOTIFICATION_EVENT.ACCESS_APPROVED]: 'settings',
  [NOTIFICATION_EVENT.ACCESS_DENIED]: 'settings',
  [NOTIFICATION_EVENT.NDA_PENDING]: 'team',
  [NOTIFICATION_EVENT.NDA_SIGNED]: 'team',
  [NOTIFICATION_EVENT.PHASE_PROMOTED]: 'team',
  [NOTIFICATION_EVENT.STEP_ASSIGNED]: 'rails',
  [NOTIFICATION_EVENT.STEP_COMPLETED]: 'rails',
  [NOTIFICATION_EVENT.RAIL_TEMPLATE_UPDATED]: 'rails',
  [NOTIFICATION_EVENT.WORK_IDENTITY_REPLACED]: 'settings',
  [NOTIFICATION_EVENT.COMPLIANCE_SETTINGS_CHANGED]: 'settings',
  [NOTIFICATION_EVENT.AI_BUDGET_THRESHOLD]: 'settings',
};

// Every mailbox_* event is about the member's own mailbox setup. Matched by
// prefix so this file never names the mailbox-derived types (agent-surfaces fence).
const MAILBOX_EVENT_PREFIX = 'mailbox_';

export function destinationFor(eventType: string): NavBadgeDestination | null {
  if (eventType.startsWith(MAILBOX_EVENT_PREFIX)) return 'settings';
  return (NOTIFICATION_DESTINATION as Record<string, NavBadgeDestination | undefined>)[eventType] ?? null;
}

const SETTINGS_SECTION_FOR: Partial<Record<NotificationEvent, SettingsSectionId>> = {
  [NOTIFICATION_EVENT.AI_BUDGET_THRESHOLD]: 'organization',
  [NOTIFICATION_EVENT.COMPLIANCE_SETTINGS_CHANGED]: 'organization',
  [NOTIFICATION_EVENT.ACCESS_APPROVED]: 'organization',
  [NOTIFICATION_EVENT.ACCESS_DENIED]: 'organization',
};

const UUID_SEGMENT = /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=[/?#]|$)/i;

/** The notification's deal code, when it carries one. */
function codeOf(notification: AppNotification): string | null {
  const code = notification.payload?.code;
  return typeof code === 'string' && code ? code : null;
}

/**
 * A notification's stored link, safe and opening the deal by its code: a
 * deal segment that is a UUID is rewritten to the notification's code. The
 * stored link is kept as is only when no code resolves; null when it is not a
 * safe in-app path. Shared by the nav badges and the bell. (Stored links
 * holding the UUID: handoff E33.)
 */
export function storedHrefWithDealCode(notification: AppNotification): string | null {
  const stored = notification.payload?.href;
  if (typeof stored !== 'string') return null;
  const safe = safeAuthDestination(stored, '');
  if (!safe) return null;
  const code = codeOf(notification);
  return code ? safe.replace(UUID_SEGMENT, `/projects/${encodeURIComponent(code)}`) : safe;
}

/**
 * Where a badge's notification should open. Prefers an explicit payload href.
 * A deal opens by its code, the [projectId] URL segment (D38): the code wins
 * over the deal UUID, and a stored link whose deal segment is a UUID is
 * rewritten to the code when the notification carries one. The UUID is kept
 * only when there is no code. (Stored links holding the UUID: handoff E33.)
 */
export function badgeHref(notification: AppNotification): string {
  const type = notification.event_type;
  const code = codeOf(notification);

  const explicit = storedHrefWithDealCode(notification);
  if (explicit) return explicit;

  const dest = destinationFor(type);
  const project = code ? encodeURIComponent(code) : notification.deal_id;

  switch (dest) {
    case 'mail':
      return project ? `/projects/${project}/mail` : '/projects';
    case 'team':
      return project ? `/projects/${project}/team` : '/projects';
    case 'rails':
      return project ? `/projects/${project}/rail` : '/projects';
    case 'settings': {
      if (type === NOTIFICATION_EVENT.ACCESS_REQUESTED) return organizationSettingsHref('requests');
      const section: SettingsSectionId = type.startsWith(MAILBOX_EVENT_PREFIX)
        ? 'mail'
        : // Looked up by string, as destinationFor does, so no expression here
          // carries the mailbox-derived event types (agent-surfaces fence).
          ((SETTINGS_SECTION_FOR as Partial<Record<string, SettingsSectionId>>)[type] ?? 'profile');
      return settingsHref(section);
    }
    default:
      return project ? `/projects/${project}` : '/projects';
  }
}
