'use client';

import {
  COMPANY_PERMISSION,
  COMPANY_PERMISSION_LABELS,
  type CompanyPermission,
} from '@/lib/constants/companyPermissions';
import type { CompanyPermissionDefinition } from './companyAccessUi';

const tableClass =
  'w-full border-collapse bg-[var(--surface)] text-left text-[length:var(--text-base)] text-[var(--ink)]';
const thClass =
  'border-b border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]';
const tdClass = 'border-b border-[var(--stroke)] px-[var(--space-3)] py-[14px] align-top';

const PERMISSION_NOTES: Partial<Record<CompanyPermission, string>> = {
  [COMPANY_PERMISSION.ROLES_MANAGE]:
    'Permits creating, editing, and archiving custom company roles.',
  [COMPANY_PERMISSION.ACCESS_ASSIGN]:
    'Permits changing employee roles and direct grants within the holder\'s authority.',
};

export function CompanyPermissionsTable({
  permissions,
  selectedKeys,
  viewerKeys,
  busy = false,
  readOnly = false,
  onToggle,
}: {
  permissions: CompanyPermissionDefinition[];
  selectedKeys: ReadonlySet<CompanyPermission>;
  viewerKeys?: ReadonlySet<CompanyPermission>;
  busy?: boolean;
  readOnly?: boolean;
  onToggle?: (key: CompanyPermission, checked: boolean) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--stroke)]">
      <table className={tableClass}>
        <thead>
          <tr>
            {readOnly ? null : (
              <th scope="col" className={`${thClass} w-12 text-center`}>
                Grant
              </th>
            )}
            <th scope="col" className={thClass}>
              Permission
            </th>
            <th scope="col" className={thClass}>
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {permissions.map((permission) => {
            const checked = selectedKeys.has(permission.key);
            const grantable = readOnly || !viewerKeys || viewerKeys.has(permission.key);
            const note = PERMISSION_NOTES[permission.key];
            return (
              <tr key={permission.key}>
                {readOnly ? null : (
                  <td className={`${tdClass} text-center`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || (!grantable && !checked)}
                      aria-label={permission.label}
                      className="h-4 w-4 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      onChange={(event) => onToggle?.(permission.key, event.target.checked)}
                    />
                  </td>
                )}
                <td className={`${tdClass} font-medium`}>
                  {permission.label}
                  {!readOnly && !grantable ? (
                    <span className="mt-[2px] block text-[length:var(--text-xs)] font-normal text-[var(--ink-secondary)]">
                      Outside your authority.
                    </span>
                  ) : null}
                </td>
                <td className={`${tdClass} text-[var(--ink-secondary)]`}>
                  <span className="block text-[length:var(--text-xs)]">{permission.description}</span>
                  {note ? (
                    <span className="mt-[var(--space-1)] block text-[length:var(--text-xs)] font-medium">
                      {note}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function permissionLabelsForKeys(
  keys: readonly CompanyPermission[],
  permissions: CompanyPermissionDefinition[],
): string[] {
  return keys.map(
    (key) =>
      permissions.find((permission) => permission.key === key)?.label ??
      COMPANY_PERMISSION_LABELS[key],
  );
}
