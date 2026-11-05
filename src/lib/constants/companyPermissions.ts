// Company-level access permissions. Mirror the immutable catalogue and key
// CHECK. The current CHECK is
// supabase/migrations/20261002110000_rail_catalog_templates.sql.

export const COMPANY_PERMISSION = {
  DIRECTORY_VIEW_ALL: 'company:directory:view_all',
  INVITES_SEND: 'company:invites:send',
  ROLES_MANAGE: 'company:roles:manage',
  ACCESS_ASSIGN: 'company:access:assign',
  LEADS_VIEW: 'company:leads:view',
  LEADS_CREATE: 'company:leads:create',
  DEALS_CREATE: 'company:deals:create',
  DEALS_ADD_MEMBERS: 'company:deals:add_members',
  DEAL_STEPS_COMPLETE: 'company:deals:steps:complete',
  DEAL_STEPS_ASSIGN: 'company:deals:steps:assign',
  DEAL_STEPS_UPDATE_UNASSIGNED: 'company:deals:steps:update_unassigned',
  DEAL_STEPS_STRUCTURE: 'company:deals:steps:structure',
  RAIL_TEMPLATES_MANAGE: 'company:rails:templates:manage',
  COMPLIANCE_NOTIFY: 'company:compliance:notify',
} as const;

export type CompanyPermission =
  (typeof COMPANY_PERMISSION)[keyof typeof COMPANY_PERMISSION];

export const COMPANY_PERMISSIONS = Object.values(
  COMPANY_PERMISSION,
) as CompanyPermission[];

/** Human labels remain available even when a viewer cannot read the catalogue. */
export const COMPANY_PERMISSION_LABELS: Record<CompanyPermission, string> = {
  [COMPANY_PERMISSION.DIRECTORY_VIEW_ALL]: 'View full employee directory',
  [COMPANY_PERMISSION.INVITES_SEND]: 'Send company invitations',
  [COMPANY_PERMISSION.ROLES_MANAGE]: 'Manage company roles',
  [COMPANY_PERMISSION.ACCESS_ASSIGN]: 'Assign employee access',
  [COMPANY_PERMISSION.LEADS_VIEW]: 'View Leads',
  [COMPANY_PERMISSION.LEADS_CREATE]: 'Create leads',
  [COMPANY_PERMISSION.DEALS_CREATE]: 'Create deals',
  [COMPANY_PERMISSION.DEALS_ADD_MEMBERS]: 'Add people on deals',
  [COMPANY_PERMISSION.DEAL_STEPS_COMPLETE]: 'Mark deal steps complete',
  [COMPANY_PERMISSION.DEAL_STEPS_ASSIGN]: 'Assign deal steps',
  [COMPANY_PERMISSION.DEAL_STEPS_UPDATE_UNASSIGNED]: 'Update unassigned deal steps',
  [COMPANY_PERMISSION.DEAL_STEPS_STRUCTURE]: 'Add and remove deal steps',
  [COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]: 'Configure rail templates',
  [COMPANY_PERMISSION.COMPLIANCE_NOTIFY]: 'Receive new-mandate notices',
};

/** Narrow an untrusted value to a known company permission key. */
export function isCompanyPermission(value: unknown): value is CompanyPermission {
  return (
    typeof value === 'string' &&
    (COMPANY_PERMISSIONS as readonly string[]).includes(value)
  );
}

/** Resolve an untrusted value to a known company permission key, else null. */
export function resolveCompanyPermission(value: unknown): CompanyPermission | null {
  return isCompanyPermission(value) ? value : null;
}
