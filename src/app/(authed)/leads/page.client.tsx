'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';

import { AccessNeededPanel } from '@/components/access/AccessNeededPanel';
import { CrmNetworkPreview } from '@/components/leads/CrmNetworkPreview';
import { LeadList } from '@/components/leads/LeadList';
import { LeadsCrmTabs, type LeadsCrmTab } from '@/components/leads/LeadsCrmTabs';
import { PeopleList } from '@/components/leads/PeopleList';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useCrmFocus } from '@/lib/leads/crmFocusStore';
import { parseCrmLeadsFocus } from '@/lib/leads/crmLeadsNavigation';
import { resolveCrmScope } from '@/lib/leads/crmScope';
import { canAccessLeads, canCreateLead, navUserFromProfile } from '@/lib/navigation/navPolicy';

function LeadsAccessSpinner() {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center bg-[var(--surface-warm)] px-[var(--space-5)] py-[var(--space-5)]"
      aria-busy="true"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="size-6 animate-spin rounded-full border-2 border-[var(--stroke)] border-t-[var(--accent)]"
      />
      <p className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Loading
      </p>
    </div>
  );
}

export default function LeadsPageClient() {
  const searchParams = useSearchParams();
  const focus = React.useMemo(() => parseCrmLeadsFocus(searchParams), [searchParams]);
  // The focused person lives in the URL fragment, which the search params never see:
  // a store the graph publishes to (and hashchange and a deep link feed) tells us.
  const focusPersonName = useCrmFocus();
  const { state } = useCurrentUser();

  if (state.status !== 'ready') {
    return <LeadsAccessSpinner />;
  }

  const navUser = navUserFromProfile(state.data.user, state.data.company_permissions);
  if (!canAccessLeads(navUser)) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-[var(--surface-warm)] px-[var(--space-5)] py-[var(--space-5)]">
        <AccessNeededPanel destination={ACCESS_DESTINATION.LEADS} />
      </div>
    );
  }

  const scope = resolveCrmScope(navUser, state.data.company?.name ?? null);
  const showCreate = canCreateLead(navUser);
  const focusTab = focus.tab ?? 'companies';
  return (
    <LeadsWorkspace
      scope={scope}
      showCreate={showCreate}
      focusTab={focusTab}
      focusLeadId={focus.leadId}
      focusPersonName={focusPersonName}
    />
  );
}

function LeadsWorkspace({
  scope,
  showCreate,
  focusTab,
  focusLeadId,
  focusPersonName,
}: {
  scope: ReturnType<typeof resolveCrmScope>;
  showCreate: boolean;
  focusTab: LeadsCrmTab;
  focusLeadId?: string;
  focusPersonName?: string;
}) {
  const [tab, setTab] = React.useState<LeadsCrmTab>(focusTab);
  const [prevFocusTab, setPrevFocusTab] = React.useState(focusTab);
  if (focusTab !== prevFocusTab) {
    setPrevFocusTab(focusTab);
    setTab(focusTab);
  }

  const [peopleReloadKey, setPeopleReloadKey] = React.useState(0);
  const [networkReloadKey, setNetworkReloadKey] = React.useState(0);

  function handleTabChange(next: LeadsCrmTab) {
    setTab(next);
    if (next === 'people') setPeopleReloadKey((key) => key + 1);
    if (next === 'network') setNetworkReloadKey((key) => key + 1);
  }

  return (
    <div
      className={`flex h-full min-h-0 w-full flex-col gap-[var(--space-4)] bg-[var(--surface-warm)] px-[var(--space-5)] py-[var(--space-5)] ${
        tab === 'network' ? 'overflow-hidden' : 'overflow-y-auto'
      }`}
    >
      {/* The page's one h1; the tabs are its visible title. */}
      <h1 className="sr-only">Leads</h1>
      <LeadsCrmTabs value={tab} onChange={handleTabChange} />
      <div
        id="leads-crm-panel-companies"
        role="tabpanel"
        aria-labelledby="leads-crm-tab-companies"
        hidden={tab !== 'companies'}
        className="min-h-0"
      >
        {tab === 'companies' ? (
          <LeadList
            canCreate={showCreate}
            scope={scope}
            focusLeadId={focusLeadId}
            focusPersonName={focusPersonName}
          />
        ) : null}
      </div>
      <div
        id="leads-crm-panel-people"
        role="tabpanel"
        aria-labelledby="leads-crm-tab-people"
        hidden={tab !== 'people'}
        className="min-h-0"
      >
        {tab === 'people' ? (
          <PeopleList key={peopleReloadKey} reloadKey={peopleReloadKey} scope={scope} />
        ) : null}
      </div>
      <div
        id="leads-crm-panel-network"
        role="tabpanel"
        aria-labelledby="leads-crm-tab-network"
        hidden={tab !== 'network'}
        className="min-h-0"
      >
        {tab === 'network' ? (
          <CrmNetworkPreview key={networkReloadKey} scope={scope} reloadKey={networkReloadKey} />
        ) : null}
      </div>
    </div>
  );
}
