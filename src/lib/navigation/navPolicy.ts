import { COMPANY_PERMISSION, type CompanyPermission } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE, DEPARTMENT, FIRM_ROLE, type CompanyRole, type FirmRole } from '@/lib/constants/roles';
import {
  canAccessDestination,
  type PerspectiveId,
} from '@/lib/perspective/access';

/** Minimal profile slice for shell navigation decisions. */
export type NavUser = {
  is_external: boolean;
  firm_role: FirmRole | null;
  company_id: string | null;
  company_role: CompanyRole | null;
  /** users.department; only AI Costs reads it, for the research/trading wall. */
  department?: string | null;
  /** Effective company permission keys when company access management is enabled. */
  companyPermissionKeys?: ReadonlySet<CompanyPermission>;
};

export function isBankSideUser(user: NavUser): boolean {
  if (user.firm_role === FIRM_ROLE.ADMIN || user.firm_role === FIRM_ROLE.CCO) {
    return true;
  }
  return !user.is_external;
}

/** External client company owner — manages people, not bank operations. */
export function isExternalCompanyDirector(user: NavUser): boolean {
  return user.is_external && user.company_role === COMPANY_ROLE.DIRECTOR;
}

/** Firm or company root who administers people, roles, integrations, and setup. */
export function isOrganizationAdministrator(user: NavUser): boolean {
  if (user.firm_role === FIRM_ROLE.ADMIN) return true;
  if (user.company_id && user.company_role === COMPANY_ROLE.DIRECTOR) return true;
  return hasCompanyNavPermission(user, COMPANY_PERMISSION.ACCESS_ASSIGN);
}

function hasCompanyNavPermission(user: NavUser, permission: CompanyPermission): boolean {
  return user.companyPermissionKeys?.has(permission) ?? false;
}

/**
 * New deal entry point. Mirrors the server: create_deal_gate0 refuses any
 * actor without company:deals:create (firm admins and the CCO short-circuit,
 * directors are access roots, external users are never eligible). The bank-side fallback only applies while
 * effective permissions are not loaded (flag off or profile still resolving).
 */
export function showNewDealNav(user: NavUser): boolean {
  if (user.is_external) return false;
  if (user.firm_role === FIRM_ROLE.ADMIN || user.firm_role === FIRM_ROLE.CCO) return true;
  if (user.companyPermissionKeys) {
    return hasCompanyNavPermission(user, COMPANY_PERMISSION.DEALS_CREATE);
  }
  return isBankSideUser(user);
}

/** Old organization URL; it redirects to Settings › Organization. */
export const ORGANIZATION_HREF = '/organization';

/**
 * Settings › Organization (firm seats and permissions). No nav row links here:
 * Settings opens from the avatar menu. Mirrors organizationSettingsHref() in
 * src/lib/settings/href.ts, kept literal so server nav code imports no UI.
 */
export const ORGANIZATION_SETTINGS_HREF = '/settings?section=organization';

/**
 * The avatar menu's Organization link: firm admins and company directors, the
 * people who run Settings › Organization. It needs a company, as that section
 * does (settingsSectionsFor). Everyone else reaches it through Settings.
 */
export function showOrganizationMenuLink(user?: NavUser | null): boolean {
  if (!user || user.company_id === null) return false;
  return user.firm_role === FIRM_ROLE.ADMIN || user.company_role === COMPANY_ROLE.DIRECTOR;
}

export function showCommandCenterNav(_user?: NavUser | null): boolean {
  return true;
}

/** Sidebar / switcher deal picker — bank rail users, or anyone who may create deals. */
export function showDealSelector(user: NavUser, perspective: PerspectiveId): boolean {
  if (canAccessDestination(perspective, 'rail')) return true;
  return showNewDealNav(user);
}

/**
 * Leads: the bank side, and outside parties who belong to a company (a client
 * company's director and people, whose access is decided on /leads). A seller
 * or buyer seat with no company gets no row: the server refuses their access
 * request ("Join an organization before requesting access"). Shown while the
 * profile loads.
 */
export function showLeadsNav(user?: NavUser | null): boolean {
  if (!user) return true;
  return !isOutsidePartyWithoutCompany(user);
}

/**
 * A seller or buyer seat that belongs to no company. The server refuses their
 * access requests ("Join an organization before requesting access"), so the
 * bank pages that only offer one are a dead end for them.
 */
export function isOutsidePartyWithoutCompany(user: NavUser): boolean {
  return !isBankSideUser(user) && user.company_id === null;
}

/**
 * Where /leads and /rail-templates send a seller or buyer with no company: home,
 * as /ai-costs does. Outside parties who belong to a client company keep both
 * pages (their access is decided there). Null means render the page. A page
 * redirect only; the API still decides every read.
 */
export function outsidePartyPageRedirect(user: NavUser | null): string | null {
  if (!user || !isOutsidePartyWithoutCompany(user)) return null;
  return homeHref(user);
}

/**
 * Rails in the deal nav and the phone bar: the rail is bank-internal (its API
 * refuses outside parties), so outside parties get no row. A direct visit to
 * /rail is still allowed and the rail says why it is empty.
 */
export function showRailsNav(perspective: PerspectiveId): boolean {
  return perspective !== 'external';
}

/**
 * Discovery (deal_discovery): bank side only, in the internal shell. The
 * list itself is RLS-gated, so a banker with no evidence sees an empty list
 * rather than a missing row.
 */
export function showDiscoveryNav(
  user: NavUser | null,
  perspective: PerspectiveId,
  enabled: boolean,
): boolean {
  return enabled && perspective === 'storm' && user !== null && !user.is_external;
}

/**
 * Data Room (deal_data_room_nav): internal users see the row only while the
 * flag is on (MVP 2 ships Deal Folder only). External seats always keep it,
 * since the Data Room is their only document view. The route itself is never
 * gated by this.
 */
export function showDataRoomNav(enabled: boolean, perspective: PerspectiveId): boolean {
  return enabled || perspective === 'external';
}

/** Whether the caller may use /leads (not merely see the nav row). */
export function canAccessLeads(user: NavUser): boolean {
  if (isExternalCompanyDirector(user)) return true;
  if (user.firm_role === FIRM_ROLE.ADMIN || user.firm_role === FIRM_ROLE.CCO) {
    return true;
  }
  if (user.companyPermissionKeys) {
    return hasCompanyNavPermission(user, COMPANY_PERMISSION.LEADS_VIEW);
  }
  if (isBankSideUser(user)) return true;
  return user.is_external;
}

export function canCreateLead(user: NavUser): boolean {
  if (isExternalCompanyDirector(user)) return true;
  if (user.firm_role === FIRM_ROLE.ADMIN || user.firm_role === FIRM_ROLE.CCO) {
    return true;
  }
  if (user.companyPermissionKeys) {
    return hasCompanyNavPermission(user, COMPANY_PERMISSION.LEADS_CREATE);
  }
  if (isBankSideUser(user)) return true;
  return false;
}

/** The firm-wide AI spend page (Issue #155). */
export const AI_COSTS_HREF = '/ai-costs';

/**
 * AI Costs is shown only to the roles /api/v1/ai-spend answers firm-wide:
 * firm admin, CCO, and the bank's company directors outside the research and
 * trading wall (firmMailAccess). Unlike Leads,
 * the row is hidden rather than decided on the page, because firm spend is
 * permissioned (Weekly Build Sync, 2026-09-22).
 */
export function showAiCostsNav(user?: NavUser | null): boolean {
  if (!user || user.is_external) return false;
  if (user.firm_role === FIRM_ROLE.ADMIN || user.firm_role === FIRM_ROLE.CCO) return true;
  if (user.department === DEPARTMENT.RESEARCH || user.department === DEPARTMENT.TRADING) return false;
  return user.company_role === COMPANY_ROLE.DIRECTOR;
}

/** Company catalog of named rail templates. Hidden until the permission is granted. */
export const RAIL_TEMPLATES_HREF = '/rail-templates';
export const RAIL_TEMPLATES_NAV_LABEL = 'Rails configuration';

export function showRailTemplatesNav(user?: NavUser | null): boolean {
  if (!user) return false;
  return hasCompanyNavPermission(user, COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE);
}

export function canAddDealMembers(user: NavUser): boolean {
  if (isBankSideUser(user)) return true;
  return hasCompanyNavPermission(user, COMPANY_PERMISSION.DEALS_ADD_MEMBERS);
}

export function isOrganizationPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === ORGANIZATION_HREF || pathname === `${ORGANIZATION_HREF}/`) return true;
  return /^\/companies\/[^/]+\/(members|roles)\/?$/.test(pathname);
}

/** Authenticated home for this persona. External company directors manage
 *  people, so they land on Settings › Organization. */
export function homeHref(user: NavUser): string {
  if (isExternalCompanyDirector(user) && user.company_id) return ORGANIZATION_SETTINGS_HREF;
  return '/projects';
}

export function navUserFromProfile(
  profile: {
    is_external?: boolean | null;
    firm_role?: string | null;
    company_id?: string | null;
    company_role?: string | null;
    department?: string | null;
  },
  companyPermissions?: Array<{ permissionKey: string }>,
): NavUser {
  const keys = companyPermissions
    ?.map((permission) => permission.permissionKey)
    .filter((key): key is CompanyPermission =>
      Object.values(COMPANY_PERMISSION).includes(key as CompanyPermission),
    );
  return {
    is_external: profile.is_external === true,
    firm_role: (profile.firm_role as FirmRole | null) ?? null,
    company_id: (profile.company_id as string | null) ?? null,
    company_role: (profile.company_role as CompanyRole | null) ?? null,
    department: profile.department ?? null,
    companyPermissionKeys: keys ? new Set(keys) : undefined,
  };
}
