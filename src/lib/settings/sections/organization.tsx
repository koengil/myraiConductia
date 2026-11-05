import { OrganizationSettings } from '@/components/company/OrganizationSettings';

import type { SettingsSection } from '../types';

export const organizationSection: SettingsSection = {
  id: 'organization',
  label: 'Organization',
  render: () => <OrganizationSettings />,
};
