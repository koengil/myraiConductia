import { MailSettingsSection } from '@/components/mail/MailSettingsSection';

import type { SettingsSection } from '../types';

export const mailSection: SettingsSection = {
  id: 'mail',
  label: 'Mail',
  render: () => <MailSettingsSection />,
};
