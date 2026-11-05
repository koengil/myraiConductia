'use client';

import * as React from 'react';

import {
  COMPANY_PERMISSION,
  COMPANY_PERMISSION_LABELS,
  COMPANY_PERMISSIONS,
  type CompanyPermission,
} from '@/lib/constants/companyPermissions';
import type { CompanyPermissionDefinition, CompanyRoleSummary } from './companyAccessUi';

export const ACCESS_CHOICE_COPY = {
  roleOutside: "Includes a permission you don't have, so you can't give it. You can take it away.",
  permissionOutside: "You don't have this permission, so you can't give it. You can take it away.",
  noRoles: 'No roles yet. Create one under Roles.',
} as const;

const legendClass = 'text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]';
const optionClass = 'flex items-start gap-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]';
const checkboxClass =
  'mt-[2px] h-4 w-4 shrink-0 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const noteClass = 'block text-[length:var(--text-xs)] text-[var(--ink-secondary)]';

/**
 * What each permission lets someone do, in plain words. The catalogue's own
 * descriptions are written for engineers ("within the actor grant envelope"),
 * so the screen says this instead; an unknown key falls back to the catalogue.
 */
const PERMISSION_PLAIN_DESCRIPTIONS: Record<CompanyPermission, string> = {
  [COMPANY_PERMISSION.DIRECTORY_VIEW_ALL]: 'See everyone at the firm in this list, including people behind an information wall.',
  [COMPANY_PERMISSION.INVITES_SEND]: 'Invite colleagues to the firm. Inviting someone to a deal is separate.',
  [COMPANY_PERMISSION.ROLES_MANAGE]: 'Create, edit and archive roles, using only permissions they have themselves.',
  [COMPANY_PERMISSION.ACCESS_ASSIGN]: 'Give people roles and permissions, using only permissions they have themselves.',
  [COMPANY_PERMISSION.LEADS_VIEW]: 'See the Leads page.',
  [COMPANY_PERMISSION.LEADS_CREATE]: 'Add a new lead company.',
  [COMPANY_PERMISSION.DEALS_CREATE]: 'Start a new deal.',
  [COMPANY_PERMISSION.DEALS_ADD_MEMBERS]: 'Add people to deals the firm is on.',
  [COMPANY_PERMISSION.DEAL_STEPS_COMPLETE]: "Mark a step assigned to them complete on the firm's deals.",
  [COMPANY_PERMISSION.DEAL_STEPS_ASSIGN]: 'Assign deal steps to people on the deal team.',
  [COMPANY_PERMISSION.DEAL_STEPS_UPDATE_UNASSIGNED]: 'Save work on deal steps nobody is assigned to yet.',
  [COMPANY_PERMISSION.DEAL_STEPS_STRUCTURE]: "Add a step to a deal's rail, and remove or restore one.",
  [COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]: 'Save a rail as a named template, starting from the default or a saved one.',
  [COMPANY_PERMISSION.COMPLIANCE_NOTIFY]: 'Get the screening notice when a new mandate opens.',
};

/** Whether the viewer may give every permission in the role. */
function roleGrantable(role: CompanyRoleSummary, viewerPermissionKeys: ReadonlySet<CompanyPermission>): boolean {
  return role.permissionKeys.every((key) => viewerPermissionKeys.has(key));
}

/** The permission catalogue (or the fixed labels when it could not be read), described plainly. */
export function permissionCatalogue(
  permissions: readonly CompanyPermissionDefinition[],
): { key: CompanyPermission; label: string; description: string }[] {
  const rows =
    permissions.length > 0
      ? permissions.map(({ key, label, description }) => ({ key, label, description }))
      : COMPANY_PERMISSIONS.map((key) => ({ key, label: COMPANY_PERMISSION_LABELS[key], description: '' }));
  return rows.map((row) => ({ ...row, description: PERMISSION_PLAIN_DESCRIPTIONS[row.key] ?? row.description }));
}

/**
 * Role and permission checkboxes for an access edit (one person inline, or
 * several in "Set access"). An item the viewer cannot give is disabled with
 * the reason beside it; one already held stays enabled so it can be taken away.
 */
export function AccessChoiceFields({
  roles,
  permissions,
  viewerPermissionKeys,
  selectedRoles,
  selectedDirect,
  disabled,
  onRolesChange,
  onDirectChange,
}: {
  roles: readonly CompanyRoleSummary[];
  permissions: readonly CompanyPermissionDefinition[];
  viewerPermissionKeys: ReadonlySet<CompanyPermission>;
  selectedRoles: ReadonlySet<string>;
  selectedDirect: ReadonlySet<CompanyPermission>;
  disabled: boolean;
  onRolesChange: (next: Set<string>) => void;
  onDirectChange: (next: Set<CompanyPermission>) => void;
}) {
  return (
    <div className="flex flex-col gap-[var(--space-4)]">
      <fieldset className="flex flex-col gap-[var(--space-2)]">
        <legend className={legendClass}>Roles</legend>
        {roles.map((role) => {
          const checked = selectedRoles.has(role.id);
          const grantable = roleGrantable(role, viewerPermissionKeys);
          return (
            <label key={role.id} className={optionClass}>
              <input
                type="checkbox"
                className={checkboxClass}
                checked={checked}
                disabled={disabled || (!grantable && !checked)}
                onChange={(event) => {
                  const next = new Set(selectedRoles);
                  if (event.target.checked) next.add(role.id);
                  else next.delete(role.id);
                  onRolesChange(next);
                }}
              />
              <span>
                {role.name}
                {role.description ? <span className={noteClass}>{role.description}</span> : null}
                {!grantable ? <span className={noteClass}>{ACCESS_CHOICE_COPY.roleOutside}</span> : null}
              </span>
            </label>
          );
        })}
        {roles.length === 0 ? (
          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">{ACCESS_CHOICE_COPY.noRoles}</p>
        ) : null}
      </fieldset>
      <fieldset className="flex flex-col gap-[var(--space-2)]">
        <legend className={legendClass}>Permissions on their own</legend>
        {permissionCatalogue(permissions).map((permission) => {
          const checked = selectedDirect.has(permission.key);
          const grantable = viewerPermissionKeys.has(permission.key);
          return (
            <label key={permission.key} className={optionClass}>
              <input
                type="checkbox"
                className={checkboxClass}
                checked={checked}
                disabled={disabled || (!grantable && !checked)}
                onChange={(event) => {
                  const next = new Set(selectedDirect);
                  if (event.target.checked) next.add(permission.key);
                  else next.delete(permission.key);
                  onDirectChange(next);
                }}
              />
              <span>
                {permission.label}
                {permission.description ? <span className={noteClass}>{permission.description}</span> : null}
                {!grantable ? <span className={noteClass}>{ACCESS_CHOICE_COPY.permissionOutside}</span> : null}
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}

/** True when the choice holds anything the viewer could not give. */
export function choiceOutsideEnvelope(
  roles: readonly CompanyRoleSummary[],
  selectedRoles: ReadonlySet<string>,
  selectedDirect: ReadonlySet<CompanyPermission>,
  viewerPermissionKeys: ReadonlySet<CompanyPermission>,
): boolean {
  return (
    roles.some((role) => selectedRoles.has(role.id) && !roleGrantable(role, viewerPermissionKeys)) ||
    [...selectedDirect].some((key) => !viewerPermissionKeys.has(key))
  );
}
