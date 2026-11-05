import type { SettingsSection } from '../types';

export const NOTIFICATIONS_COPY =
  'Notification preferences do not exist yet. Notifications arrive in the bell and in the badges on the navigation, and nothing on this page changes them.';

export const notificationsSection: SettingsSection = {
  id: 'notifications',
  label: 'Notifications',
  render: () => (
    <p className="max-w-[60ch] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{NOTIFICATIONS_COPY}</p>
  ),
};
