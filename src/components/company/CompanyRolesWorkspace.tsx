'use client';

import * as React from 'react';

import { AccessNeededPanel } from '@/components/access/AccessNeededPanel';
import { CompanyTabs } from '@/components/company/CompanyTabs';
import { CompanyPermissionsTable } from '@/components/company/CompanyPermissionsTable';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';
import {
  effectivePermissionKeys,
  type CompanyPermissionDefinition,
  type CompanyRolesResponse,
  type CompanyRoleSummary,
} from '@/components/company/companyAccessUi';
import type { CompanyEffectivePermission } from '@/lib/api/v1/companyAccess';
import { COMPANY_PERMISSION, COMPANY_PERMISSION_LABELS, type CompanyPermission } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE } from '@/lib/constants/roles';
import { useFlag } from '@/lib/flags/FlagsContext';

type Viewer = {
  firm_role: string | null;
  company_id: string | null;
  company_role: string | null;
  is_external?: boolean;
};

type RoleDraft = {
  roleId: string | null;
  expectedVersion: number | null;
  name: string;
  description: string;
  permissionKeys: Set<CompanyPermission>;
};

type PageMessage = {
  text: string;
  kind: 'success' | 'error';
};

const panelClass =
  'rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]';
const buttonClass =
  'inline-flex items-center rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60';
const inputClass =
  'w-full rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[8px] text-[length:var(--text-sm)] text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const primaryButtonClass =
  'inline-flex items-center rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60';

function RolesHeading({ inSettings }: { inSettings: boolean }) {
  const Tag = inSettings ? 'h3' : 'h1';
  return (
    <Tag className="text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
      Roles &amp; permissions
    </Tag>
  );
}

function newDraft(): RoleDraft {
  return {
    roleId: null,
    expectedVersion: null,
    name: '',
    description: '',
    permissionKeys: new Set(),
  };
}

function roleDraft(role: CompanyRoleSummary): RoleDraft {
  return {
    roleId: role.id,
    expectedVersion: role.version,
    name: role.name,
    description: role.description ?? '',
    permissionKeys: new Set(role.permissionKeys),
  };
}

/**
 * Company roles and their permissions. Rendered by Settings › Organization
 * (Roles tab) for the viewer's own company, and by /companies/[id]/roles for
 * any other company.
 */
export function CompanyRolesWorkspace({
  companyId,
  inSettings = false,
}: {
  companyId: string;
  /** Inside Settings: no page chrome, and the tabs link to Settings. */
  inSettings?: boolean;
}) {
  const enabled = useFlag('company_access_management');
  const [viewer, setViewer] = React.useState<Viewer | null>(null);
  const [data, setData] = React.useState<CompanyRolesResponse | null>(null);
  const [draft, setDraft] = React.useState<RoleDraft | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<PageMessage | null>(null);

  const load = React.useCallback(async () => {
    if (!companyId || !enabled) return;
    try {
      const [meResponse, rolesResponse] = await Promise.all([
        fetch('/api/v1/me'),
        fetch(`/api/v1/companies/${companyId}/roles`),
      ]);
      const meBody = (await meResponse.json().catch(() => null)) as {
        user?: Viewer;
        company_permissions?: CompanyEffectivePermission[];
      } | null;
      const rolesBody = (await rolesResponse.json().catch(() => null)) as
        | (CompanyRolesResponse & { error?: string })
        | null;
      if (!meResponse.ok || !meBody?.user) {
        setMessage({ text: 'Session lookup failed.', kind: 'error' });
        return;
      }
      setViewer(meBody.user);
      if (rolesResponse.status === 403) {
        setData(null);
        return;
      }
      if (!rolesResponse.ok || !rolesBody) {
        setData(null);
        setMessage({
          text: rolesBody?.error ?? 'Roles and permissions could not be loaded.',
          kind: 'error',
        });
        return;
      }
      setData(rolesBody);
    } catch {
      setMessage({ text: 'Roles and permissions could not be loaded.', kind: 'error' });
    } finally {
      setLoading(false);
    }
  }, [companyId, enabled]);

  React.useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  if (!companyId) return null;

  if (!enabled) {
    return (
      <div
        className={
          inSettings
            ? 'flex items-start'
            : 'flex h-full w-full items-start bg-[var(--surface-warm)] p-[var(--space-5)]'
        }
      >
        <section className={panelClass}>
          {/* Inside Settings the page h1 and the section h2 sit above this. */}
          <RolesHeading inSettings={inSettings} />
          <p className="mt-[var(--space-1)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            Company access management is not available.
          </p>
        </section>
      </div>
    );
  }

  const protectedRoot = Boolean(
    viewer &&
      (viewer.firm_role === 'admin' ||
        (viewer.company_role === COMPANY_ROLE.DIRECTOR && viewer.company_id === companyId)),
  );
  const isExternalDirector = Boolean(
    viewer?.is_external &&
      viewer.company_role === COMPANY_ROLE.DIRECTOR &&
      viewer.company_id === companyId,
  );
  const viewerKeys = effectivePermissionKeys(data?.viewerPermissions);
  const canManage = protectedRoot || viewerKeys.has(COMPANY_PERMISSION.ROLES_MANAGE);

  async function saveRole(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setMessage(null);
    try {
      const editing = Boolean(draft.roleId);
      const response = await fetch(
        editing
          ? `/api/v1/companies/${companyId}/roles/${draft.roleId}`
          : `/api/v1/companies/${companyId}/roles`,
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(editing ? { expectedVersion: draft.expectedVersion } : {}),
            name: draft.name,
            description: draft.description.trim() || null,
            permissionKeys: [...draft.permissionKeys],
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (response.status === 409) {
        setDraft(null);
        setMessage({
          text: 'This role changed while you were editing. The latest roles have been reloaded.',
          kind: 'error',
        });
        await load();
        return;
      }
      if (!response.ok) {
        setMessage({ text: body?.error ?? 'The role could not be saved.', kind: 'error' });
        return;
      }
      setDraft(null);
      setMessage({ text: editing ? 'Role saved.' : 'Role created.', kind: 'success' });
      await load();
    } catch {
      setMessage({ text: 'The role could not be saved.', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function archiveRole(role: CompanyRoleSummary) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/v1/companies/${companyId}/roles/${role.id}?expectedVersion=${role.version}`,
        { method: 'DELETE' },
      );
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        assignmentCount?: number;
      } | null;
      if (response.status === 409) {
        setMessage({
          text:
            typeof body?.assignmentCount === 'number'
              ? `This role is assigned to ${body.assignmentCount} ${body.assignmentCount === 1 ? 'member' : 'members'} and cannot be archived.`
              : 'This role changed while you were working. The latest roles have been reloaded.',
          kind: 'error',
        });
        await load();
        return;
      }
      if (!response.ok) {
        setMessage({ text: body?.error ?? 'The role could not be archived.', kind: 'error' });
        return;
      }
      setMessage({ text: 'Role archived.', kind: 'success' });
      await load();
    } catch {
      setMessage({ text: 'The role could not be archived.', kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={
        inSettings
          ? 'flex w-full flex-col'
          : 'flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--surface-warm)]'
      }
    >
      <div
        className={
          inSettings
            ? 'flex flex-col gap-[var(--space-5)]'
            : 'flex flex-col gap-[var(--space-5)] px-[var(--space-5)] py-[var(--space-5)]'
        }
      >
        <CompanyTabs companyId={companyId} current="roles" inSettings={inSettings} />
        {message ? (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`text-[length:var(--text-sm)] ${
              message.kind === 'error' ? 'text-[var(--negative)]' : 'text-[var(--ink-secondary)]'
            }`}
          >
            {message.text}
          </p>
        ) : null}
        {loading ? (
          <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">Loading roles.</p>
        ) : (
          <>
            {!canManage ? (
              <AccessNeededPanel destination={ACCESS_DESTINATION.ROLES} />
            ) : null}
            {!data ? null : (
          <>
            <div className="flex items-center justify-between gap-[var(--space-3)]">
              <div>
                <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                  {isExternalDirector ? 'Roles' : 'Custom roles'}
                </h2>
                <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  {isExternalDirector
                    ? 'A role is a named set of permissions. Give someone a role from the Roster.'
                    : 'A role is a named set of permissions. Someone with two roles can do everything in both. Directors and firm administrators always have every permission.'}
                </p>
              </div>
              {canManage ? (
                <button type="button" className={buttonClass} onClick={() => setDraft(newDraft())}>
                  Create role
                </button>
              ) : null}
            </div>

            <section aria-label="Company roles" className="grid gap-[var(--space-3)] lg:grid-cols-2">
              {data.roles.map((role) => (
                <article key={role.id} className={panelClass}>
                  <div>
                    <h3 className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                      {role.name}
                    </h3>
                    {role.description ? (
                      <p className="mt-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                        {role.description}
                      </p>
                    ) : null}
                  </div>
                  <p className="mt-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                    {role.assignmentCount} {role.assignmentCount === 1 ? 'member' : 'members'} ·{' '}
                    {role.permissionKeys.length} {role.permissionKeys.length === 1 ? 'permission' : 'permissions'}
                  </p>
                  <div className="mt-[var(--space-2)] flex flex-wrap gap-[var(--space-2)]">
                    {role.permissionKeys.length > 0 ? (
                      role.permissionKeys.map((key) => (
                        <span
                          key={key}
                          className="rounded-[6px] bg-[var(--surface-subtle)] px-[var(--space-2)] py-[3px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]"
                        >
                          {data.permissions.find((permission) => permission.key === key)?.label ??
                            COMPANY_PERMISSION_LABELS[key as CompanyPermission]}
                        </span>
                      ))
                    ) : (
                      <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                        No permissions assigned.
                      </span>
                    )}
                  </div>
                  {canManage ? (
                    <div className="mt-[var(--space-4)] flex flex-wrap items-center gap-[var(--space-2)]">
                      <button type="button" className={buttonClass} disabled={busy} onClick={() => setDraft(roleDraft(role))}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy || role.assignmentCount > 0}
                        title={role.assignmentCount > 0 ? 'Remove all assignments before archiving this role.' : undefined}
                        onClick={() => void archiveRole(role)}
                      >
                        Archive
                      </button>
                      {role.assignmentCount > 0 ? (
                        <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                          Assigned roles cannot be archived.
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
              {data.roles.length === 0 ? (
                <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                  No custom roles yet.
                </p>
              ) : null}
            </section>

            {draft ? (
              <RoleEditor
                draft={draft}
                permissions={data.permissions}
                viewerKeys={viewerKeys}
                busy={busy}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSubmit={saveRole}
              />
            ) : null}
          </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RoleEditor({
  draft,
  permissions,
  viewerKeys,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: RoleDraft;
  permissions: CompanyPermissionDefinition[];
  viewerKeys: ReadonlySet<CompanyPermission>;
  busy: boolean;
  onChange: (draft: RoleDraft) => void;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const outsideEnvelopeSelection = [...draft.permissionKeys].some(
    (key) => !viewerKeys.has(key),
  );

  return (
    <section className={panelClass} aria-label={draft.roleId ? `Edit ${draft.name}` : 'Create role'}>
      <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-[var(--space-4)]">
        <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
          {draft.roleId ? `Edit ${draft.name}` : 'Create role'}
        </h2>
        <label className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
          Role name
          <input
            required
            minLength={2}
            maxLength={80}
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            className={`${inputClass} mt-[var(--space-1)]`}
          />
        </label>
        <label className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
          Description
          <textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            className={`${inputClass} mt-[var(--space-1)] min-h-20`}
          />
        </label>
        <fieldset className="flex flex-col gap-[var(--space-3)]">
          <legend className="text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]">
            Permissions
          </legend>
          <CompanyPermissionsTable
            permissions={permissions}
            selectedKeys={draft.permissionKeys}
            viewerKeys={viewerKeys}
            busy={busy}
            onToggle={(key, checked) => {
              const keys = new Set(draft.permissionKeys);
              if (checked) keys.add(key);
              else keys.delete(key);
              onChange({ ...draft, permissionKeys: keys });
            }}
          />
        </fieldset>
        {outsideEnvelopeSelection ? (
          <p role="status" className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            Remove permissions outside your authority before saving this role.
          </p>
        ) : null}
        <div className="flex gap-[var(--space-2)]">
          <button type="submit" className={primaryButtonClass} disabled={busy || outsideEnvelopeSelection}>
            {busy ? 'Saving role' : 'Save role'}
          </button>
          <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
