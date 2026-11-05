import { redirect } from 'next/navigation';

import { organizationSettingsHref } from '@/lib/settings/href';

/** Organization moved into Settings; old links and bookmarks land there. */
export default function OrganizationPage() {
  redirect(organizationSettingsHref());
}
