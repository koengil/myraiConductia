'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

import { AccessNeededPanel } from '@/components/access/AccessNeededPanel';
import { CompanyMembersView } from '@/components/company/CompanyMembersWorkspace';
import { CompanyRolesWorkspace } from '@/components/company/CompanyRolesWorkspace';
import { Gate0LeadLoader } from '@/components/wizard/Gate0LeadLoader';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';

/**
 * Settings › Organization: the firm's seats and permissions for the viewer's
 * own company (roster, permission requests, roles). Access is decided by the
 * roster itself.
 */
export function OrganizationSettings() {
  return (
    <React.Suspense fallback={<Gate0LeadLoader label="Loading members…" />}>
      <OrganizationSettingsBody />
    </React.Suspense>
  );
}

function OrganizationSettingsBody() {
  const { state } = useCurrentUser();
  const searchParams = useSearchParams();

  if (state.status === 'loading') return <Gate0LeadLoader label="Loading members…" />;
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Your organization could not be loaded. Reload the page to try again.
      </p>
    );
  }

  const companyId = state.data.user.company_id;
  if (!companyId) return <AccessNeededPanel destination={ACCESS_DESTINATION.ORGANIZATION} />;

  if (searchParams.get('tab') === 'roles') {
    return <CompanyRolesWorkspace companyId={companyId} inSettings />;
  }
  return <CompanyMembersView companyId={companyId} inSettings />;
}
