'use client';

import * as React from 'react';
import { Lock } from 'lucide-react';

import { Button } from '@/components/atoms/Button';
import { COMPANY_PERMISSION_LABELS, type CompanyPermission } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE } from '@/lib/constants/roles';
import { accessWriteFailureCopy } from '@/lib/company/bulkAccess';
import { AccessChoiceFields, choiceOutsideEnvelope, permissionCatalogue } from './AccessChoiceFields';
import type {
  CompanyMemberAccess,
  CompanyPermissionDefinition,
  CompanyRoleSummary,
} from './companyAccessUi';

export const MEMBER_ACCESS_COPY = {
  explainer:
    "Permissions cover firm-wide work, like inviting people or creating deals. To see a deal's work and documents, a person also needs a seat on that deal's team.",
  // Fixed access, said of the person it sits under: a director (whatever
  // other role they hold, such as the CCO) or a firm administrator.
  lockedDirector: 'As a director, they have every permission. Their access is fixed.',
  lockedAdministrator: 'As a firm administrator, they have every permission. Their access is fixed.',
  lockedNoAuthority: 'Only a director, or someone who can assign access, changes this.',
  outsideEnvelope: "Take away the items you can't give before saving.",
  stale: 'Someone else changed this access while you were editing. The latest is loaded. Make your change again.',
  saved: 'Access saved.',
  loadFailed: 'Their access could not be loaded.',
  saveFailed: 'Access was not saved.',
  unsaved: 'You have unsaved access changes.',
  none: 'No firm permissions yet.',
} as const;

function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Why a person's access is fixed. The server fixes it for a company's
 * directors and for a firm administrator (app_company_is_access_root), so a
 * fixed member who is not a director is the firm administrator.
 */
export function fixedAccessReason(companyRole: string | null): string {
  return companyRole === COMPANY_ROLE.DIRECTOR
    ? MEMBER_ACCESS_COPY.lockedDirector
    : MEMBER_ACCESS_COPY.lockedAdministrator;
}

function sourceText(source: CompanyMemberAccess['effective_permissions'][number]['source']): string {
  if (source.type === 'role') return source.name ? `From ${source.name}` : 'From a role';
  if (source.type === 'direct') return 'Given on its own';
  return 'Comes with their role';
}

/**
 * One person's firm permissions, shown inline under their roster row
 * (Settings › Organization). It opens read-only: a plain list of what they
 * can do and where each permission comes from. Editing is a separate,
 * explicit step (`editing`, entered from "Edit access"), and a control the
 * viewer cannot use is never shown as one: the reason is shown instead.
 * The row above already shows the name and email, so this never repeats them.
 */
export function MemberAccessPanel({
  companyId,
  member,
  initialAccess,
  roles,
  permissions,
  viewerPermissionKeys,
  canAssign,
  editing,
  onEditingChange,
  onDirtyChange,
  discardPrompt = false,
  onKeepEditing,
  onDiscard,
  onAccessChange,
}: {
  companyId: string;
  member: { id: string; companyRole: string | null };
  initialAccess?: CompanyMemberAccess;
  roles: readonly CompanyRoleSummary[];
  permissions: readonly CompanyPermissionDefinition[];
  /** What the viewer may give at this company. */
  viewerPermissionKeys: ReadonlySet<CompanyPermission>;
  /** The viewer may assign access at this company. */
  canAssign: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** The parent tried to close or switch rows with edits unsaved. */
  discardPrompt?: boolean;
  onKeepEditing?: () => void;
  onDiscard?: () => void;
  onAccessChange: (access: CompanyMemberAccess) => void;
}) {
  const [access, setAccess] = React.useState<CompanyMemberAccess | null>(initialAccess ?? null);
  const [selectedRoles, setSelectedRoles] = React.useState<Set<string>>(
    () => new Set(initialAccess?.assigned_roles.map((role) => role.id) ?? []),
  );
  const [selectedDirect, setSelectedDirect] = React.useState<Set<CompanyPermission>>(
    () => new Set(initialAccess?.direct_permissions ?? []),
  );
  const [loading, setLoading] = React.useState(!initialAccess);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  const protectedRoot =
    member.companyRole === COMPANY_ROLE.DIRECTOR ||
    Boolean(access?.effective_permissions.some((permission) => permission.source.type === 'root'));
  const mayEdit = canAssign && !protectedRoot;
  const isEditing = editing && mayEdit && access !== null;

  const savedRoles = React.useMemo(
    () => new Set(access?.assigned_roles.map((role) => role.id) ?? []),
    [access],
  );
  const savedDirect = React.useMemo(() => new Set(access?.direct_permissions ?? []), [access]);
  const dirty = isEditing && (!setsEqual(selectedRoles, savedRoles) || !setsEqual(selectedDirect, savedDirect));
  const outside = isEditing && choiceOutsideEnvelope(roles, selectedRoles, selectedDirect, viewerPermissionKeys);

  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const applySnapshot = React.useCallback(
    (next: CompanyMemberAccess) => {
      setAccess(next);
      setSelectedRoles(new Set(next.assigned_roles.map((role) => role.id)));
      setSelectedDirect(new Set(next.direct_permissions));
      onAccessChange(next);
    },
    [onAccessChange],
  );

  const load = React.useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/companies/${companyId}/members/${member.id}/access`);
      const body = (await response.json().catch(() => null)) as {
        access?: CompanyMemberAccess;
        error?: string;
      } | null;
      if (!response.ok || !body?.access) {
        setMessage(body?.error ?? MEMBER_ACCESS_COPY.loadFailed);
        return;
      }
      applySnapshot(body.access);
    } catch {
      setMessage(MEMBER_ACCESS_COPY.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, companyId, member.id]);

  React.useEffect(() => {
    // Load once per person; a later snapshot from the parent does not refetch.
    if (!initialAccess) {
      void (async () => {
        await load();
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startOver() {
    setSelectedRoles(new Set(savedRoles));
    setSelectedDirect(new Set(savedDirect));
  }

  function cancelEdit() {
    startOver();
    setMessage(null);
    onEditingChange(false);
  }

  async function save() {
    if (!access) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/companies/${companyId}/members/${member.id}/access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: access.version,
          roleIds: [...selectedRoles],
          directPermissions: [...selectedDirect],
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        access?: CompanyMemberAccess;
        error?: string;
      } | null;
      if (response.status === 409 && !body?.error?.startsWith('Protected')) {
        setMessage(MEMBER_ACCESS_COPY.stale);
        await load();
        return;
      }
      if (!response.ok || !body?.access) {
        setMessage(
          (response.ok ? null : accessWriteFailureCopy(response.status, body?.error)) ??
            MEMBER_ACCESS_COPY.saveFailed,
        );
        return;
      }
      applySnapshot(body.access);
      setMessage(MEMBER_ACCESS_COPY.saved);
      onEditingChange(false);
    } catch {
      setMessage(MEMBER_ACCESS_COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const labels = new Map(permissionCatalogue(permissions).map((permission) => [permission.key, permission.label]));
  const held = access?.effective_permissions ?? [];
  const lockReason = protectedRoot
    ? fixedAccessReason(member.companyRole)
    : !canAssign
      ? MEMBER_ACCESS_COPY.lockedNoAuthority
      : null;

  return (
    <div className="flex flex-col gap-[var(--space-3)] pt-[var(--space-1)]">
      <p className="max-w-prose text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {MEMBER_ACCESS_COPY.explainer}
      </p>

      {discardPrompt ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--stroke-strong)] bg-[var(--surface-subtle)] p-[var(--space-3)]"
        >
          <p className="mr-auto text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
            {MEMBER_ACCESS_COPY.unsaved}
          </p>
          <Button size="sm" variant="secondary" onClick={onKeepEditing}>
            Keep editing
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              startOver();
              onDiscard?.();
            }}
          >
            Discard changes
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {message}
        </p>
      ) : null}

      {loading ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">Loading access.</p>
      ) : !access ? null : isEditing ? (
        <>
          <AccessChoiceFields
            roles={roles}
            permissions={permissions}
            viewerPermissionKeys={viewerPermissionKeys}
            selectedRoles={selectedRoles}
            selectedDirect={selectedDirect}
            disabled={saving}
            onRolesChange={setSelectedRoles}
            onDirectChange={setSelectedDirect}
          />
          {outside ? (
            <p role="status" className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              {MEMBER_ACCESS_COPY.outsideEnvelope}
            </p>
          ) : null}
          <div className="flex gap-[var(--space-2)]">
            <Button size="sm" variant="secondary" disabled={saving} onClick={cancelEdit}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving || outside || !dirty} onClick={() => void save()}>
              {saving ? 'Saving access' : 'Save access'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-[var(--space-1)]">
            <h4 className="text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]">Roles</h4>
            <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
              {access.assigned_roles.length > 0
                ? access.assigned_roles.map((role) => role.name).join(', ')
                : protectedRoot
                  ? 'Every permission'
                  : 'No roles'}
            </p>
          </div>
          <div className="flex flex-col gap-[var(--space-1)]">
            <h4 className="text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]">
              What they can do
            </h4>
            {held.length === 0 ? (
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{MEMBER_ACCESS_COPY.none}</p>
            ) : (
              <ul className="flex flex-col gap-[var(--space-1)]">
                {held.map((permission) => (
                  <li
                    key={`${permission.permissionKey}:${permission.source.type}:${permission.source.id ?? ''}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink)]"
                  >
                    <span>
                      {labels.get(permission.permissionKey) ??
                        COMPANY_PERMISSION_LABELS[permission.permissionKey]}
                    </span>
                    {protectedRoot ? null : (
                      <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                        {sourceText(permission.source)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {lockReason ? (
            <p className="flex items-start gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
              <Lock aria-hidden="true" className="mt-[1px] size-3.5 shrink-0" />
              <span>{lockReason}</span>
            </p>
          ) : (
            <div>
              <Button size="sm" variant="secondary" onClick={() => onEditingChange(true)}>
                Edit access
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
