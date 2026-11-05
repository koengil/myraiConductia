import { RailsSettings } from '@/components/settings/RailsSettings';

import type { SettingsSection } from '../types';

export const railsSection: SettingsSection = {
  id: 'rails',
  label: 'Rails',
  render: () => <RailsSettings />,
};
