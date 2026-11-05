import { ProfileView } from '@/app/(authed)/profile/ProfileView';

import type { SettingsSection } from '../types';

export const profileSection: SettingsSection = {
  id: 'profile',
  label: 'Profile',
  render: () => <ProfileView />,
};
