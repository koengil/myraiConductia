import type { LeadsCrmTab } from '@/components/leads/LeadsCrmTabs';
import { fragmentHref, readFragmentValue } from '@/lib/util/fragment';

import { publishCrmFocus } from './crmFocusStore';

export type CrmLeadsFocus = {
  tab?: LeadsCrmTab;
  leadId?: string;
  personName?: string;
};

/**
 * Tab and lead come from the query (opaque ids). The person is a name, so it
 * rides in the fragment (`#person=`), which never reaches a server or its logs
 * (#331); a `?person=` in the query is ignored.
 */
export function parseCrmLeadsFocus(params: URLSearchParams, hash = ''): CrmLeadsFocus {
  const tab = params.get('tab');
  const leadId = params.get('lead')?.trim() || undefined;
  const personName = readFragmentValue(hash, 'person');

  return {
    tab:
      tab === 'companies' || tab === 'people' || tab === 'network'
        ? tab
        : leadId
          ? 'companies'
          : undefined,
    leadId,
    personName,
  };
}

export function buildCrmLeadsHref(focus: CrmLeadsFocus): string {
  const params = new URLSearchParams();
  if (focus.tab) params.set('tab', focus.tab);
  if (focus.leadId) params.set('lead', focus.leadId);
  const query = params.toString();
  const path = query ? `/leads?${query}` : '/leads';
  return focus.personName ? `${path}${fragmentHref('person', focus.personName)}` : path;
}

/** DOM id for scrolling to a highlighted person row in LeadDetail. */
export function crmPersonFocusId(personName: string): string {
  return `crm-focus-${personName.trim().toLowerCase().replace(/\s+/g, '-')}`;
}

/** Navigate from a network node to the lead company with that person focused. */
export function crmLeadsHrefForNetworkNode(leadId: string, personName: string): string {
  return buildCrmLeadsHref({
    tab: 'companies',
    leadId,
    personName,
  });
}

/**
 * Navigate to a leads href and publish the focused person (undefined clears it).
 * router.push calls history.pushState, which never fires `hashchange`, and a
 * second person on the same lead and tab changes only the fragment, so the page
 * would not notice. The focus store is how it does.
 */
export function pushCrmFocus(
  router: { push: (href: string) => void },
  href: string,
  personName: string | undefined,
): void {
  router.push(href);
  publishCrmFocus(personName);
}
