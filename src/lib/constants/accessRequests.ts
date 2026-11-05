import { organizationSettingsHref } from '@/lib/settings/href';

import { COMPANY_PERMISSION, type CompanyPermission } from './companyPermissions';

export const ACCESS_DESTINATION = {
  LEADS: 'leads',
  LEADS_CREATE: 'leads_create',
  ORGANIZATION: 'organization',
  ROLES: 'roles',
  ACCESS_ASSIGN: 'access_assign',
  COMPLIANCE_NOTIFY: 'compliance_notify',
  RAIL_TEMPLATES: 'rail_templates',
} as const;

export type AccessDestination =
  (typeof ACCESS_DESTINATION)[keyof typeof ACCESS_DESTINATION];

export const ACCESS_DESTINATIONS = Object.values(
  ACCESS_DESTINATION,
) as AccessDestination[];

export const ACCESS_REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
} as const;

export type AccessRequestStatus =
  (typeof ACCESS_REQUEST_STATUS)[keyof typeof ACCESS_REQUEST_STATUS];

export type AccessDestinationDef = {
  id: AccessDestination;
  label: string;
  permission: CompanyPermission;
  /** Where the requester lands after a decision. Requests are always about the
   *  requester's own company, so company destinations go straight to Settings. */
  hrefFor: (companyId: string) => string;
};

export const ACCESS_DESTINATION_DEFS: Record<AccessDestination, AccessDestinationDef> = {
  [ACCESS_DESTINATION.LEADS]: {
    id: ACCESS_DESTINATION.LEADS,
    label: 'Leads',
    permission: COMPANY_PERMISSION.LEADS_VIEW,
    hrefFor: () => '/leads',
  },
  [ACCESS_DESTINATION.LEADS_CREATE]: {
    id: ACCESS_DESTINATION.LEADS_CREATE,
    label: 'Create leads',
    permission: COMPANY_PERMISSION.LEADS_CREATE,
    hrefFor: () => '/leads',
  },
  [ACCESS_DESTINATION.ORGANIZATION]: {
    id: ACCESS_DESTINATION.ORGANIZATION,
    label: 'Organization',
    permission: COMPANY_PERMISSION.DIRECTORY_VIEW_ALL,
    hrefFor: () => organizationSettingsHref(),
  },
  [ACCESS_DESTINATION.ROLES]: {
    id: ACCESS_DESTINATION.ROLES,
    label: 'Roles',
    permission: COMPANY_PERMISSION.ROLES_MANAGE,
    hrefFor: () => organizationSettingsHref('roles'),
  },
  [ACCESS_DESTINATION.ACCESS_ASSIGN]: {
    id: ACCESS_DESTINATION.ACCESS_ASSIGN,
    label: 'Assign employee access',
    permission: COMPANY_PERMISSION.ACCESS_ASSIGN,
    hrefFor: () => organizationSettingsHref('requests'),
  },
  [ACCESS_DESTINATION.COMPLIANCE_NOTIFY]: {
    id: ACCESS_DESTINATION.COMPLIANCE_NOTIFY,
    label: 'Receive new-mandate notices',
    permission: COMPANY_PERMISSION.COMPLIANCE_NOTIFY,
    hrefFor: () => organizationSettingsHref('requests'),
  },
  [ACCESS_DESTINATION.RAIL_TEMPLATES]: {
    id: ACCESS_DESTINATION.RAIL_TEMPLATES,
    label: 'Rails configuration',
    permission: COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE,
    hrefFor: () => '/rail-templates',
  },
};

/**
 * Where an approver reviews the queue — never the locked destination itself.
 * Approvers can sit outside the requester's company (a firm admin), so this
 * names the company; for the approver's own company the old URL redirects to
 * Settings › Organization.
 */
export function approverInboxHref(companyId: string): string {
  return `/companies/${companyId}/members?tab=requests`;
}

export function isAccessDestination(value: unknown): value is AccessDestination {
  return (
    typeof value === 'string' &&
    (ACCESS_DESTINATIONS as readonly string[]).includes(value)
  );
}
