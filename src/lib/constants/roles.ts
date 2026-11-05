// Role + department constants. Mirror the CHECK enums in
// supabase/migrations/20260604100000_permissions_schema.sql (the source of
// truth). Keep these in sync when the schema changes.

/** Deal-scoped roles (deal_memberships.deal_role + roles.slug subset). */
export const DEAL_ROLE = {
  MD: 'md',
  DEAL_TEAM: 'deal_team',
  LEGAL: 'legal',
  SELLER: 'seller',
  BUYER: 'buyer',
  READ_ONLY: 'read_only',
} as const;

export type DealRole = (typeof DEAL_ROLE)[keyof typeof DEAL_ROLE];
export const DEAL_ROLES = Object.values(DEAL_ROLE) as DealRole[];

/** Firm-wide elevated roles (users.firm_role). */
export const FIRM_ROLE = {
  CCO: 'cco',
  ADMIN: 'admin',
} as const;

export type FirmRole = (typeof FIRM_ROLE)[keyof typeof FIRM_ROLE];
export const FIRM_ROLES = Object.values(FIRM_ROLE) as FirmRole[];

/**
 * Company-level role (users.company_role). A 'director' administers the
 * company's members (add/remove/fire); a 'member' does not.
 * Distinct from the deal-level 'md' (deal owner) and the platform firm_role.
 * Mirrors supabase/migrations/20260612120000_company_membership.sql.
 */
export const COMPANY_ROLE = {
  DIRECTOR: 'director',
  MEMBER: 'member',
} as const;

export type CompanyRole = (typeof COMPANY_ROLE)[keyof typeof COMPANY_ROLE];
export const COMPANY_ROLES = Object.values(COMPANY_ROLE) as CompanyRole[];

/**
 * Deal roles an internal colleague can be granted or prefer. `md` is the
 * protected creator seat, `seller`/`buyer` are external party seats, and
 * firm roles are not deal seats. Mirrors the users_preferred_deal_role CHECK
 * in supabase/migrations/20260814120000_preferred_deal_role.sql and the
 * internal-invitation rule in proposalFeasibility.
 */
export const INTERNAL_ASSIGNABLE_DEAL_ROLES = [
  DEAL_ROLE.DEAL_TEAM,
  DEAL_ROLE.LEGAL,
  DEAL_ROLE.READ_ONLY,
] as const satisfies readonly DealRole[];

export type InternalAssignableDealRole = (typeof INTERNAL_ASSIGNABLE_DEAL_ROLES)[number];

/** Narrow an untrusted value to an assignable preferred role, else null. */
export function resolvePreferredDealRole(
  value: string | null | undefined,
): InternalAssignableDealRole | null {
  return (INTERNAL_ASSIGNABLE_DEAL_ROLES as readonly string[]).includes(value ?? '')
    ? (value as InternalAssignableDealRole)
    : null;
}

/**
 * Authoritative slug set for the `roles` table (deal roles + firm-only roles).
 * Matches the roles seed in the permissions migration. Use for seed/verify.
 */
export type RoleSlug = DealRole | FirmRole;
export const ROLE_SLUGS: RoleSlug[] = [...DEAL_ROLES, ...FIRM_ROLES];

/** Internal Chinese-wall department (users.department). */
export const DEPARTMENT = {
  IB: 'ib',
  RESEARCH: 'research',
  TRADING: 'trading',
  COMPLIANCE: 'compliance',
  LEGAL: 'legal',
  ADMIN: 'admin',
} as const;

export type Department = (typeof DEPARTMENT)[keyof typeof DEPARTMENT];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  [DEPARTMENT.IB]: 'Investment Banking',
  [DEPARTMENT.RESEARCH]: 'Research',
  [DEPARTMENT.TRADING]: 'Trading',
  [DEPARTMENT.COMPLIANCE]: 'Compliance',
  [DEPARTMENT.LEGAL]: 'Legal',
  [DEPARTMENT.ADMIN]: 'Admin',
};

/** Human-readable labels for deal roles (UI). */
export const DEAL_ROLE_LABELS: Record<DealRole, string> = {
  [DEAL_ROLE.MD]: 'Managing Director',
  [DEAL_ROLE.DEAL_TEAM]: 'Deal Team',
  [DEAL_ROLE.LEGAL]: 'Legal Counsel',
  [DEAL_ROLE.SELLER]: 'Seller',
  [DEAL_ROLE.BUYER]: 'Buyer',
  [DEAL_ROLE.READ_ONLY]: 'Observer',
};

/** Human-readable labels for firm roles (UI). */
export const FIRM_ROLE_LABELS: Record<FirmRole, string> = {
  [FIRM_ROLE.CCO]: 'Chief Compliance Officer',
  [FIRM_ROLE.ADMIN]: 'Administrator',
};

/** Human-readable labels for company roles (UI). */
export const COMPANY_ROLE_LABELS: Record<CompanyRole, string> = {
  [COMPANY_ROLE.DIRECTOR]: 'Director',
  [COMPANY_ROLE.MEMBER]: 'Member',
};

/** Organization identity for chrome and the roster — never a deal-seat title. */
export function organizationRoleLabel(user: {
  firm_role?: string | null;
  company_role?: string | null;
}): string {
  if (user.firm_role && user.firm_role in FIRM_ROLE_LABELS) {
    return FIRM_ROLE_LABELS[user.firm_role as FirmRole];
  }
  if (user.company_role && user.company_role in COMPANY_ROLE_LABELS) {
    return COMPANY_ROLE_LABELS[user.company_role as CompanyRole];
  }
  return COMPANY_ROLE_LABELS[COMPANY_ROLE.MEMBER];
}
