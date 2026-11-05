import { redirect } from 'next/navigation';

import { CompanyRolesWorkspace } from '@/components/company/CompanyRolesWorkspace';
import { getNavUser } from '@/lib/navigation/serverNav';
import { organizationSettingsHref } from '@/lib/settings/href';

/**
 * Your own company's roles live in Settings › Organization (Roles tab); this
 * old URL redirects there. Any other company's roles still render here.
 */
export default async function CompanyRolesPage({
  params,
}: Readonly<{ params: Promise<{ companyId: string }> }>) {
  const { companyId } = await params;
  const navUser = await getNavUser();
  if (navUser?.company_id === companyId) {
    redirect(organizationSettingsHref('roles'));
  }
  return <CompanyRolesWorkspace companyId={companyId} />;
}
