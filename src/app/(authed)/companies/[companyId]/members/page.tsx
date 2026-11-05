import { redirect } from 'next/navigation';

import { CompanyMembersView } from '@/components/company/CompanyMembersWorkspace';
import { getNavUser } from '@/lib/navigation/serverNav';
import { organizationSettingsHref } from '@/lib/settings/href';

/**
 * Your own company's roster lives in Settings › Organization; this old URL
 * redirects there (keeping the Permission requests tab). Any other company's
 * roster still renders here.
 */
export default async function CompanyMembersPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}>) {
  const { companyId } = await params;
  const { tab } = await searchParams;
  const navUser = await getNavUser();
  if (navUser?.company_id === companyId) {
    redirect(organizationSettingsHref(tab === 'requests' ? 'requests' : undefined));
  }
  return <CompanyMembersView companyId={companyId} />;
}
