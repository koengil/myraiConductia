import { FIRM_ROLE } from '@/lib/constants/roles';
import { type NavUser, isBankSideUser } from '@/lib/navigation/navPolicy';

export type CrmScopeContext = {
  /** When true, the caller sees the full tenant catalog (bank internal). */
  tenantWide: boolean;
  /** Managed company name when the catalog is org-scoped. */
  orgName: string | null;
};

/**
 * Bank overseers and internal deal teams see the tenant-wide CRM.
 * Customer org users see only their org's leads and people.
 */
export function resolveCrmScope(
  navUser: NavUser | null,
  orgName: string | null,
): CrmScopeContext {
  if (!navUser) {
    return { tenantWide: false, orgName: null };
  }

  const tenantWide =
    isBankSideUser(navUser) &&
    (navUser.firm_role === FIRM_ROLE.ADMIN ||
      navUser.firm_role === FIRM_ROLE.CCO ||
      !navUser.is_external);

  return {
    tenantWide,
    orgName: tenantWide ? null : orgName,
  };
}

export function crmScopeHeadline(scope: CrmScopeContext): string {
  if (scope.tenantWide) return 'Firm CRM';
  if (scope.orgName) return `${scope.orgName} CRM`;
  return 'Your organization CRM';
}

export function crmScopeDescription(scope: CrmScopeContext): string {
  if (scope.tenantWide) {
    return 'Leads, people, and maps across the firm. Customer orgs only see their own catalog.';
  }
  if (scope.orgName) {
    return `Leads and people registered by ${scope.orgName}. Other customer organizations cannot see this catalog.`;
  }
  return 'Leads and people scoped to your organization. Other customer organizations cannot see this catalog.';
}
