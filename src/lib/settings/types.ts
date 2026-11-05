import type { ReactNode } from 'react';

export type SettingsSectionId = 'profile' | 'organization' | 'mail' | 'rails' | 'notifications';

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  render: () => ReactNode;
};
