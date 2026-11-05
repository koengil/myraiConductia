'use client';

import * as React from 'react';
import { Lock, Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/atoms/Button';
import { AccessNeededPanel } from '@/components/access/AccessNeededPanel';
import { AccessRequestInbox } from '@/components/access/AccessRequestInbox';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';
import { BulkAccessDialog } from '@/components/company/BulkAccessDialog';
import { CompanyTabs, parseCompanyMembersTab } from '@/components/company/CompanyTabs';
import { InviteMemberDialog, type InvitePendingConfirm } from '@/components/company/InviteMemberDialog';
import { mapWithAccessLimit } from '@/lib/company/bulkAccess';
import { fixedAccessReason, MemberAccessPanel } from '@/components/company/MemberAccessPanel';
import {
  Dialog,
  Disclosure,
  Menu,
  useRetainedWhileClosing,
  type MenuItem,
} from '@/components/overlay';
import { groupByRole } from '@/lib/company/rosterGroups';
import {
  effectivePermissionKeys,
  type CompanyMemberAccess,
  type CompanyRolesResponse,
} from '@/components/company/companyAccessUi';
import { Gate0LeadLoader } from '@/components/wizard/Gate0LeadLoader';
import type { CompanyEffectivePermission } from '@/lib/api/v1/companyAccess';
import {
  getCompanyRosterSnapshot,
  setCompanyRosterSnapshot,
  type CompanyRosterInvite,
  type CompanyRosterMember,
  type CompanyRosterViewer,
} from '@/lib/company/companyRosterCache';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import {
  COMPANY_ROLE,
  COMPANY_ROLE_LABELS,
  DEPARTMENT_LABELS,
  FIRM_ROLE,
  organizationRoleLabel,
  type CompanyRole,
  type Department,
} from '@/lib/constants/roles';
import { useFlag } from '@/lib/flags/FlagsContext';
import { RESEND_UNDELIVERED } from '@/lib/team/inviteAccess';
import { preflightInvite } from '@/lib/team/invitePreflight';
import { formatDateTime } from '@/lib/format/date';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

/**
 * The company owner's member management view (Aug 4 sync, Roberto), shown in
 * Settings › Organization. Directors and firm admins see the roster, pending
 * invites, role controls, and the delegated can-invite toggle. Members holding
 * the delegated can_invite right see the roster and the invite modal only.
 * Everyone else gets a closed panel. All mutations are enforced server-side;
 * the client gate only shapes the UI.
 *
 * Invites run the domain preflight first: a non-matching address surfaces an
 * explicit confirmation step before delivery.
 */

type Viewer = CompanyRosterViewer;
type Member = CompanyRosterMember;
type PendingInvite = CompanyRosterInvite;

const ROSTER_LOAD_ERROR = 'The roster could not be loaded.';

type MeResponse = {
  user: Viewer;
  company_permissions?: CompanyEffectivePermission[];
};

const buttonClass =
  'inline-flex items-center rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[7px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60';
const listClass =
  'overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]';
const fieldClass =
  'rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[8px] text-[length:var(--text-sm)] text-[var(--ink)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const checkboxClass =
  'h-4 w-4 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

/** "Administrator" means the firm administrator only; a company's director is a Director. */
function companyRoleLabel(role: string | null, externalHrView: boolean): string {
  if (externalHrView) {
    return role === COMPANY_ROLE.DIRECTOR ? 'Director' : 'Employee';
  }
  if (role && role in COMPANY_ROLE_LABELS) {
    return COMPANY_ROLE_LABELS[role as CompanyRole];
  }
  return COMPANY_ROLE_LABELS[COMPANY_ROLE.MEMBER];
}

function departmentLabel(department: string | null): string | null {
  if (!department) return null;
  if (department in DEPARTMENT_LABELS) {
    return DEPARTMENT_LABELS[department as Department];
  }
  return department;
}

function memberName(member: Pick<Member, 'display_name' | 'full_name'>): string {
  return member.display_name || member.full_name;
}

function memberAssignedRoleId(memberId: string, access: Record<string, CompanyMemberAccess>): string {
  return access[memberId]?.assigned_roles[0]?.id ?? '';
}

function memberAssignedRoleName(
  member: Member,
  access: Record<string, CompanyMemberAccess>,
): string {
  if (member.company_role === COMPANY_ROLE.DIRECTOR) return 'Director';
  const assigned = access[member.id]?.assigned_roles[0]?.name;
  return assigned ?? 'Employee';
}

/**
 * Whose access is fixed, as the server decides it (app_company_is_access_root,
 * supabase/migrations/20260816120000_client_company_access_management.sql):
 * in a company whose access is managed (bank or client), its directors, and a
 * firm administrator. Outside (client) directors are therefore fixed too; the
 * replace RPC refuses them with protected_access_root. A loaded snapshot that
 * reports a root grant counts as well.
 */
export function isFixedAccessMember(
  member: Pick<Member, 'id' | 'company_role' | 'firm_role'>,
  access: Record<string, CompanyMemberAccess>,
): boolean {
  return (
    member.company_role === COMPANY_ROLE.DIRECTOR ||
    member.firm_role === 'admin' ||
    Boolean(
      access[member.id]?.effective_permissions.some(
        (permission) => permission.source.type === 'root',
      ),
    )
  );
}

/**
 * Whom only a firm administrator may remove: the firm administrator, the CCO
 * and directors. UI only. The server protects directors and the firm
 * administrator on access changes (the access PATCH routes), not the CCO as
 * such, and DELETE /api/v1/companies/{id}/members/{userId} has no
 * protected-role check yet (handoff E27); so the row menu offers Remove on
 * these people to a firm administrator only and shows everyone else why it
 * is locked.
 */
function isRemovalProtected(member: Pick<Member, 'firm_role' | 'company_role'>): boolean {
  return (
    member.firm_role === FIRM_ROLE.ADMIN ||
    member.firm_role === FIRM_ROLE.CCO ||
    member.company_role === COMPANY_ROLE.DIRECTOR
  );
}

const REMOVE_PROTECTED_REASON =
  'Only a firm administrator can remove a director, a compliance officer or an administrator.';

function isProtectedRoot(viewer: Viewer, companyId: string): boolean {
  return (
    viewer.firm_role === 'admin' ||
    (viewer.company_role === COMPANY_ROLE.DIRECTOR && viewer.company_id === companyId)
  );
}

/** An outside party's director, looking at their own company. */
function isOwnExternalDirector(viewer: Viewer, companyId: string): boolean {
  return (
    viewer.is_external &&
    viewer.company_role === COMPANY_ROLE.DIRECTOR &&
    viewer.company_id === companyId
  );
}

function InvitePlusButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-[var(--stroke)] text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <Plus className="size-4" aria-hidden="true" />
    </button>
  );
}

/**
 * An outside party's director gives their people one of the firm's roles.
 * Opens read-only; "Change role" is the explicit step that shows the picker.
 */
function MemberRoleDetail({
  name,
  roleId,
  roleName,
  loaded,
  roles,
  busy,
  editing,
  onEditingChange,
  onSave,
}: {
  name: string;
  roleId: string;
  roleName: string;
  /** False when their current role could not be read: never claim "No role". */
  loaded: boolean;
  roles: { id: string; name: string }[];
  busy: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onSave: (roleId: string) => Promise<boolean>;
}) {
  const [choice, setChoice] = React.useState(roleId);
  if (!editing) {
    return (
      <div className="flex flex-col gap-[var(--space-2)] pt-[var(--space-1)]">
        <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
          <span className="text-[var(--ink-tertiary)]">Role </span>
          {roleName}
        </p>
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setChoice(roleId);
              onEditingChange(true);
            }}
          >
            Change role
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[var(--space-2)] pt-[var(--space-1)] sm:flex-row sm:items-center">
      <select
        value={choice}
        disabled={busy}
        aria-label={`Role for ${name}`}
        onChange={(event) => setChoice(event.target.value)}
        className={`${fieldClass} sm:max-w-xs`}
      >
        {loaded ? (
          <option value="">No role</option>
        ) : (
          <option value="" disabled>
            Select role
          </option>
        )}
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      <div className="flex gap-[var(--space-2)]">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setChoice(roleId);
            onEditingChange(false);
          }}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || choice === roleId}
          onClick={() => {
            void onSave(choice).then((saved) => {
              if (saved) onEditingChange(false);
            });
          }}
        >
          Save role
        </Button>
      </div>
    </div>
  );
}

/**
 * The company roster. Settings › Organization renders it for the viewer's own
 * company; /companies/[id]/members renders it for any other company. Keyed on
 * the company and the access flag so a switch starts from a clean slate.
 */
export function CompanyMembersView({
  companyId,
  inSettings = false,
}: {
  companyId: string;
  /** Inside Settings: no page chrome, and the tabs link to Settings. */
  inSettings?: boolean;
}) {
  const companyAccessEnabled = useFlag('company_access_management');
  return (
    <React.Suspense fallback={<Gate0LeadLoader label="Loading members…" />}>
      <CompanyMembersWorkspace
        key={`${companyId}:${companyAccessEnabled}`}
        companyId={companyId}
        companyAccessEnabled={companyAccessEnabled}
        inSettings={inSettings}
      />
    </React.Suspense>
  );
}

function CompanyMembersWorkspace({
  companyId,
  companyAccessEnabled,
  inSettings,
}: {
  companyId: string;
  companyAccessEnabled: boolean;
  inSettings: boolean;
}) {
  const searchParams = useSearchParams();
  const membersTab = parseCompanyMembersTab(searchParams);
  const cachedRoster = getCompanyRosterSnapshot(companyId, companyAccessEnabled);

  const [viewer, setViewer] = React.useState<Viewer | null>(cachedRoster?.viewer ?? null);
  const [members, setMembers] = React.useState<Member[]>(cachedRoster?.members ?? []);
  const [invites, setInvites] = React.useState<PendingInvite[]>(cachedRoster?.invites ?? []);
  const [loading, setLoading] = React.useState(!cachedRoster);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<Member | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<string>(COMPANY_ROLE.MEMBER);
  const [pendingConfirm, setPendingConfirm] = React.useState<InvitePendingConfirm | null>(null);
  const [filter, setFilter] = React.useState('');
  const [viewerPermissions, setViewerPermissions] = React.useState<CompanyEffectivePermission[]>(
    cachedRoster?.viewerPermissions ?? [],
  );
  const [rolesData, setRolesData] = React.useState<CompanyRolesResponse>(
    cachedRoster?.rolesData ?? {
      permissions: [],
      roles: [],
      viewerPermissions: [],
    },
  );
  const [memberAccess, setMemberAccess] = React.useState<Record<string, CompanyMemberAccess>>(
    cachedRoster?.memberAccess ?? {},
  );
  const [roleFilter, setRoleFilter] = React.useState('');
  /** The one row open under the roster, and whether it is in its edit step. */
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [dirtyId, setDirtyId] = React.useState<string | null>(null);
  /**
   * A switch away from a row with unsaved edits waits here for Keep or
   * Discard: where to go once they are discarded (a row, in edit mode or not,
   * or Set access).
   */
  const [pendingSwitch, setPendingSwitch] = React.useState<{
    next: string | null;
    edit: boolean;
    bulk?: boolean;
  } | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = React.useState(false);
  /** Each "Set access" starts fresh from the people selected at that moment. */
  const [bulkRun, setBulkRun] = React.useState(0);
  const removing = useRetainedWhileClosing(confirmRemove);

  const refresh = React.useCallback(async () => {
    const meRes = await fetch('/api/v1/me');
    if (!meRes.ok) throw new Error('Session lookup failed');
    const me = (await meRes.json()) as MeResponse;
    setViewer(me.user);
    const externalDirector = isOwnExternalDirector(me.user, companyId);
    const clientHrTools = companyAccessEnabled && externalDirector;
    const companyAccessTools = companyAccessEnabled && !externalDirector;
    const nextViewerPermissions =
      companyAccessTools || clientHrTools ? (me.company_permissions ?? []) : [];
    setViewerPermissions(nextViewerPermissions);
    const permissionKeys = effectivePermissionKeys(nextViewerPermissions);
    const root = isProtectedRoot(me.user, companyId);
    const canAssignAccess = root || permissionKeys.has(COMPANY_PERMISSION.ACCESS_ASSIGN);
    const canReadRoles =
      root ||
      canAssignAccess ||
      permissionKeys.has(COMPANY_PERMISSION.ROLES_MANAGE);
    const includeWalled =
      !companyAccessTools ||
      root ||
      permissionKeys.has(COMPANY_PERMISSION.DIRECTORY_VIEW_ALL);

    const [membersRes, invitesRes, rolesRes] = await Promise.all([
      fetch(
        `/api/v1/companies/${companyId}/members${includeWalled ? '?includeWalled=true' : ''}`,
      ),
      fetch(`/api/v1/invites?companyId=${companyId}`),
      (companyAccessTools || clientHrTools) && canReadRoles
        ? fetch(`/api/v1/companies/${companyId}/roles`)
        : Promise.resolve(null),
    ]);
    let nextMembers: Member[] = [];
    if (membersRes.ok) {
      const data = (await membersRes.json()) as { members: Member[] };
      nextMembers = data.members;
      setMembers(nextMembers);
    } else {
      // Throw rather than cache an empty roster as if it were real (#250).
      throw new Error('roster_unavailable');
    }
    // Delegates cannot list invites (403 by design); they simply see none.
    let nextInvites: PendingInvite[] = [];
    if (invitesRes.ok) {
      const data = (await invitesRes.json()) as { invites: PendingInvite[] };
      nextInvites = data.invites.filter((i) => i.status === 'pending');
    }
    setInvites(nextInvites);
    let nextRolesData: CompanyRolesResponse = {
      permissions: [],
      roles: [],
      viewerPermissions: nextViewerPermissions,
    };
    if (rolesRes?.ok) {
      nextRolesData = (await rolesRes.json()) as CompanyRolesResponse;
    }
    setRolesData(nextRolesData);

    let nextMemberAccess: Record<string, CompanyMemberAccess> = {};
    if (companyAccessTools || clientHrTools) {
      const accessTargets = clientHrTools
        ? nextMembers.filter((member) => member.company_role !== COMPANY_ROLE.DIRECTOR)
        : canAssignAccess
          ? nextMembers
          : nextMembers.filter((member) => member.id === me.user.id);
      // Bounded like the bulk write: a roster of hundreds is not hundreds of reads at once.
      const snapshots = await mapWithAccessLimit(
        accessTargets,
        async (member) => {
          const response = await fetch(
            `/api/v1/companies/${companyId}/members/${member.id}/access`,
          );
          if (!response.ok) return null;
          const body = (await response.json().catch(() => null)) as {
            access?: CompanyMemberAccess;
          } | null;
          return body?.access ? ([member.id, body.access] as const) : null;
        },
      );
      nextMemberAccess = Object.fromEntries(
        snapshots.filter((snapshot) => snapshot !== null),
      );
    }
    setMemberAccess(nextMemberAccess);
    setCompanyRosterSnapshot(companyId, companyAccessEnabled, {
      viewer: me.user,
      members: nextMembers,
      invites: nextInvites,
      viewerPermissions: nextViewerPermissions,
      rolesData: nextRolesData,
      memberAccess: nextMemberAccess,
    });
  }, [companyAccessEnabled, companyId]);

  React.useEffect(() => {
    const cached = getCompanyRosterSnapshot(companyId, companyAccessEnabled);
    let cancelled = false;
    void (async () => {
      try {
        await refresh();
      } catch {
        if (!cancelled && !cached) {
          setError(ROSTER_LOAD_ERROR);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyAccessEnabled, companyId, refresh]);

  const canManage = Boolean(viewer && isProtectedRoot(viewer, companyId));
  const viewerPermissionKeys = effectivePermissionKeys(viewerPermissions);
  const targetCompanyGrantEnvelope = effectivePermissionKeys(rolesData.viewerPermissions);
  const canSend =
    canManage ||
    Boolean(
      viewer &&
        viewer.company_id === companyId &&
        (companyAccessEnabled
          ? viewerPermissionKeys.has(COMPANY_PERMISSION.INVITES_SEND)
          : viewer.can_invite),
    );
  const canViewDirectory =
    canManage ||
    (companyAccessEnabled &&
      viewerPermissionKeys.has(COMPANY_PERMISSION.DIRECTORY_VIEW_ALL));
  const canAssignAccess =
    canManage ||
    (companyAccessEnabled &&
      viewerPermissionKeys.has(COMPANY_PERMISSION.ACCESS_ASSIGN));
  const canManageRoles =
    canManage ||
    (companyAccessEnabled && viewerPermissionKeys.has(COMPANY_PERMISSION.ROLES_MANAGE));
  const isExternalDirector = Boolean(viewer && isOwnExternalDirector(viewer, companyId));
  const clientHrTools = companyAccessEnabled && isExternalDirector;
  const companyAccessTools = companyAccessEnabled && !isExternalDirector;
  const canUsePeople = isExternalDirector
    ? canManage || canSend
    : companyAccessTools
      ? canSend || canViewDirectory || canAssignAccess || canManageRoles
      : canSend;
  const showMemberActions = canManage && !isExternalDirector;
  const showRosterActions = showMemberActions || companyAccessTools;
  const showCompanyTabs = companyAccessEnabled && Boolean(viewer);
  const activeTab = showCompanyTabs && membersTab === 'requests' ? 'requests' : 'roster';
  const implicitNotifyRecipient = Boolean(
    viewer && (viewer.firm_role === 'cco' || isProtectedRoot(viewer, companyId)),
  );
  const canReceiveMandateNotices =
    implicitNotifyRecipient ||
    viewerPermissionKeys.has(COMPANY_PERMISSION.COMPLIANCE_NOTIFY);
  const canReviewRequests = canManage || canAssignAccess;
  const assignableRoles = rolesData.roles.filter((role) => role.name !== 'Administrator');
  const externalHrView = isExternalDirector || clientHrTools;
  const roleLabelFor = (member: Member) =>
    externalHrView ? memberAssignedRoleName(member, memberAccess) : organizationRoleLabel(member);
  const isProtected = (member: Member) => isFixedAccessMember(member, memberAccess);
  /** Several people at once: a fan-out over the one-person access write. */
  const canBulk = companyAccessTools && canAssignAccess;
  const isSelectable = (member: Member) => canBulk && !isProtected(member);
  /** Bank side: firm permissions (all of them for an assigner, else your own). */
  const hasAccessDetail = (member: Member) =>
    companyAccessTools && (canAssignAccess || member.id === viewer?.id);
  /** Outside party's director: a role for each of their people. */
  const hasRoleDetail = (member: Member) =>
    clientHrTools && canManage && member.company_role !== COMPANY_ROLE.DIRECTOR && assignableRoles.length > 0;
  const canEditAccess = (member: Member) =>
    (companyAccessTools && canAssignAccess && !isProtected(member)) || hasRoleDetail(member);

  const roleGroups = groupByRole(members, roleLabelFor);
  // A filter whose group is gone (or whose control is hidden) no longer applies.
  const activeRoleFilter =
    roleGroups.length > 1 && roleGroups.some((group) => group.label === roleFilter) ? roleFilter : '';
  const shownUnder = (member: Member, text: string, role: string) => {
    if (role && roleLabelFor(member) !== role) return false;
    const needle = text.trim().toLowerCase();
    if (!needle) return true;
    return (
      memberName(member).toLowerCase().includes(needle) ||
      member.email.toLowerCase().includes(needle)
    );
  };
  const visibleMembers = members.filter((member) => shownUnder(member, filter, activeRoleFilter));
  const visibleGroups = groupByRole(visibleMembers, roleLabelFor);
  const selectableShown = visibleMembers.filter(isSelectable);
  const allShownSelected =
    selectableShown.length > 0 && selectableShown.every((member) => selected.has(member.id));
  const someShownSelected = selectableShown.some((member) => selected.has(member.id));
  // Only people still on the roster stay selected.
  const selectedMembers = members.filter((member) => selected.has(member.id) && isSelectable(member));

  function openBulk() {
    setBulkRun((run) => run + 1);
    setBulkOpen(true);
  }

  /** Opening, closing or switching rows. Unsaved edits ask first. */
  function requestOpen(next: string | null, edit = false) {
    if (dirtyId && dirtyId === openId && next !== openId) {
      setPendingSwitch({ next, edit });
      return;
    }
    setPendingSwitch(null);
    setOpenId(next);
    setEditingId(edit ? next : null);
  }

  const onPanelDirty = React.useCallback((memberId: string, dirty: boolean) => {
    setDirtyId((current) => (dirty ? memberId : current === memberId ? null : current));
  }, []);
  const onAccessChange = React.useCallback((access: CompanyMemberAccess) => {
    setMemberAccess((current) => ({ ...current, [access.user_id]: access }));
  }, []);

  function toggleSelected(memberId: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(memberId);
      else next.delete(memberId);
      return next;
    });
  }

  /** A search or role filter that hides a selected person drops them from the selection. */
  function changeView(text: string, role: string) {
    setFilter(text);
    setRoleFilter(role);
    const appliedRole = roleGroups.length > 1 && roleGroups.some((group) => group.label === role) ? role : '';
    const shown = new Set(
      members.filter((member) => shownUnder(member, text, appliedRole)).map((member) => member.id),
    );
    setSelected((current) => {
      const kept = [...current].filter((id) => shown.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }

  function toggleAllShown(on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const member of selectableShown) {
        if (on) next.add(member.id);
        else next.delete(member.id);
      }
      return next;
    });
  }

  async function assignMemberRole(member: Member, roleId: string): Promise<boolean> {
    if (!companyId) return false;
    const access = memberAccess[member.id];
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/companies/${companyId}/members/${member.id}/access`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: access?.version ?? 0,
            // An empty selection clears the role.
            roleIds: roleId ? [roleId] : [],
            directPermissions: access?.direct_permissions ?? [],
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? 'The role was not changed.');
        if (response.status === 409) await refresh().catch(() => undefined);
        return false;
      }
      // Saved. A failed reload after it is the roster's problem, not the role's.
      await refresh().catch(() => setError(ROSTER_LOAD_ERROR));
      return true;
    } catch {
      setError('The role was not changed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function act(request: () => Promise<Response>, failure: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await request();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? failure);
      }
    } catch {
      setError(failure);
      setBusy(false);
      return;
    }
    await refresh().catch(() => setError(ROSTER_LOAD_ERROR));
    setBusy(false);
  }

  async function retryRoster() {
    setError(null);
    setBusy(true);
    await refresh().catch(() => setError(ROSTER_LOAD_ERROR));
    setBusy(false);
  }

  /** Preflight the address, then send. A non-matching domain pauses on an
   *  explicit confirmation step. */
  async function sendInvite(confirmationId?: string) {
    const email = inviteEmail.trim();
    if (!email || !companyId) return;
    setBusy(true);
    setError(null);
    try {
      if (!confirmationId) {
        const pf = await preflightInvite({ email, companyId, companyRole: inviteRole });
        if (pf.kind === 'error') {
          setError(pf.message ?? 'The address could not be checked.');
          return;
        }
        if (pf.kind === 'confirm') {
          setPendingConfirm({
            confirmationId: pf.id,
            classification: pf.classification,
            email: pf.normalizedEmail ?? email,
          });
          return;
        }
      }
      const res = await fetch('/api/v1/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          companyId,
          companyRole: inviteRole,
          ...(confirmationId ? { confirmationId } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        deliveryError?: string;
      } | null;
      if (!res.ok) {
        setError(body?.error ?? 'The invite could not be sent.');
        return;
      }
      setPendingConfirm(null);
      setInviteEmail('');
      setInviteOpen(false);
      if (body?.deliveryError) {
        setError(
          canManage
            ? 'The invite was created but the emails did not send. Resend the invitation.'
            : 'The invite was created but the email did not send. Ask a company director to resend it.',
        );
      }
      await refresh();
    } catch {
      setError('The invite could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  /** Resend rotates the credential and emails a fresh verification code. */
  async function resendInvite(invite: PendingInvite) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/invites/${invite.id}/resend`, { method: 'POST' });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        deliveryError?: string;
        deliveryStatus?: 'sent' | 'unsent';
      } | null;
      if (!res.ok) {
        setError(body?.error ?? 'The invite was not resent.');
      } else if (body?.deliveryStatus !== 'sent') {
        setError(RESEND_UNDELIVERED);
      }
      await refresh();
    } catch {
      setError('The invite was not resent.');
    } finally {
      setBusy(false);
    }
  }

  function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    void sendInvite();
  }

  const inviteLabel = viewer?.is_external ? 'Invite an employee' : 'Invite a member';
  const showInviteOnRoster = canSend && (activeTab === 'roster' || !showCompanyTabs);
  const showAccessInboxInline = (canManage || canAssignAccess) && !showCompanyTabs;

  function rowActions(member: Member, isSelf: boolean): MenuItem[] {
    const isDirector = member.company_role === COMPANY_ROLE.DIRECTOR;
    const actions: MenuItem[] = [];
    if (canEditAccess(member)) {
      actions.push({
        id: 'edit',
        label: hasRoleDetail(member) ? 'Change role' : 'Edit access',
        onSelect: () => requestOpen(member.id, true),
      });
    }
    if (showMemberActions && !companyAccessEnabled && !isDirector) {
      actions.push({
        id: 'invites',
        label: member.can_invite ? 'Withdraw invite right' : 'Allow invites',
        disabled: busy,
        onSelect: () =>
          void act(
            () =>
              fetch(`/api/v1/companies/${companyId}/members/${member.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ canInvite: !member.can_invite }),
              }),
            'The invite right was not changed.',
          ),
      });
    }
    if (showMemberActions && !isSelf) {
      const locked = isRemovalProtected(member) && viewer?.firm_role !== FIRM_ROLE.ADMIN;
      actions.push({
        id: 'remove',
        label: 'Remove',
        description: locked ? REMOVE_PROTECTED_REASON : undefined,
        disabled: busy || locked,
        destructive: !locked,
        onSelect: () => setConfirmRemove(member),
      });
    }
    return actions;
  }

  function rowSubline(member: Member): string {
    const parts = [member.email];
    const department = !isExternalDirector ? departmentLabel(member.department) : null;
    if (department) parts.push(department);
    if (member.is_walled) parts.push('walled');
    if (!companyAccessEnabled && member.can_invite && member.company_role !== COMPANY_ROLE.DIRECTOR) {
      parts.push('Can invite');
    }
    return parts.join(' · ');
  }

  function renderDetail(member: Member) {
    const onEditingChange = (editing: boolean) => setEditingId(editing ? member.id : null);
    if (hasRoleDetail(member)) {
      return (
        <MemberRoleDetail
          key={member.id}
          name={memberName(member)}
          roleId={memberAssignedRoleId(member.id, memberAccess)}
          roleName={memberAssignedRoleName(member, memberAccess)}
          loaded={Boolean(memberAccess[member.id])}
          roles={assignableRoles}
          busy={busy}
          editing={editingId === member.id}
          onEditingChange={onEditingChange}
          onSave={(roleId) => assignMemberRole(member, roleId)}
        />
      );
    }
    return (
      <MemberAccessPanel
        key={member.id}
        companyId={companyId}
        member={{ id: member.id, companyRole: member.company_role }}
        initialAccess={memberAccess[member.id]}
        roles={rolesData.roles}
        permissions={rolesData.permissions}
        viewerPermissionKeys={targetCompanyGrantEnvelope}
        canAssign={canAssignAccess}
        editing={editingId === member.id}
        onEditingChange={onEditingChange}
        onDirtyChange={(dirty) => onPanelDirty(member.id, dirty)}
        discardPrompt={pendingSwitch !== null && openId === member.id}
        onKeepEditing={() => setPendingSwitch(null)}
        onDiscard={() => {
          const next = pendingSwitch?.next ?? null;
          setDirtyId(null);
          setPendingSwitch(null);
          setOpenId(next);
          // "Edit access" from another row's menu still lands in edit mode.
          setEditingId(pendingSwitch?.edit ? next : null);
          // Set access asked first: carry on into it.
          if (pendingSwitch?.bulk) openBulk();
        }}
        onAccessChange={onAccessChange}
      />
    );
  }

  function renderRow(member: Member) {
    const isSelf = member.id === viewer?.id;
    const name = memberName(member);
    const actions = showRosterActions || clientHrTools ? rowActions(member, isSelf) : [];
    const customRoles =
      companyAccessTools && !externalHrView
        ? (memberAccess[member.id]?.assigned_roles ?? []).map((role) => role.name).join(', ')
        : '';
    const title = (
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[length:var(--text-base)] font-medium text-[var(--ink)]">
          {name}
          {isSelf ? <span className="font-normal text-[var(--ink-tertiary)]"> (you)</span> : null}
        </span>
        <span className="truncate text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {rowSubline(member)}
        </span>
      </span>
    );
    const menu =
      actions.length > 0 ? (
        <Menu label={`Actions for ${name}`} items={actions} />
      ) : showRosterActions || clientHrTools ? (
        // Reserves the menu column on a row with no actions (your own row), so
        // every row's chevron and hover end in one column.
        <span aria-hidden="true" data-menu-placeholder="" className="inline-block h-[34px] w-[34px] shrink-0" />
      ) : null;
    const expandable = hasAccessDetail(member) || hasRoleDetail(member);

    const leading = !canBulk ? null : isSelectable(member) ? (
      <input
        type="checkbox"
        className={checkboxClass}
        checked={selected.has(member.id)}
        aria-label={`Select ${name}`}
        onChange={(event) => toggleSelected(member.id, event.target.checked)}
      />
    ) : (
      <span title={fixedAccessReason(member.company_role)} className="inline-flex w-4 justify-center text-[var(--ink-tertiary)]">
        <Lock aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{`${name}: ${fixedAccessReason(member.company_role)}`}</span>
      </span>
    );

    return (
      <li key={member.id} data-member={member.id} className="border-b border-[var(--stroke)] last:border-b-0">
        {expandable ? (
          <Disclosure
            title={title}
            meta={customRoles || undefined}
            leading={leading}
            actions={menu}
            open={openId === member.id}
            onOpenChange={(open) => requestOpen(open ? member.id : null)}
          >
            {renderDetail(member)}
          </Disclosure>
        ) : (
          <div className="flex min-h-12 items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)]">
            {leading}
            <span className="min-w-0 flex-1">{title}</span>
            {customRoles ? (
              <span className="shrink-0 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">{customRoles}</span>
            ) : null}
            {menu}
          </div>
        )}
      </li>
    );
  }

  const ownMember: Member | null = viewer
    ? (members.find((member) => member.id === viewer.id) ?? {
        id: viewer.id,
        full_name: 'You',
        display_name: null,
        email: '',
        department: null,
        firm_role: viewer.firm_role,
        company_role: viewer.company_role,
        can_invite: viewer.can_invite,
        preferred_deal_role: null,
        is_walled: false,
      })
    : null;

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
            ? 'flex flex-col gap-[var(--space-6)]'
            : 'flex flex-col gap-[var(--space-6)] px-[var(--space-5)] py-[var(--space-5)]'
        }
      >
        {showCompanyTabs ? (
          <CompanyTabs companyId={companyId} current={activeTab} inSettings={inSettings} />
        ) : null}
        {showAccessInboxInline ? <AccessRequestInbox /> : null}

        {error ? (
          <div role="alert" className="flex flex-wrap items-center gap-[var(--space-3)]">
            <p className="text-[length:var(--text-sm)] text-[var(--negative,red)]">{error}</p>
            {error === ROSTER_LOAD_ERROR ? (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void retryRoster()}>
                {TRY_AGAIN_COPY}
              </Button>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <Gate0LeadLoader label="Loading members…" />
        ) : showCompanyTabs && activeTab === 'requests' ? (
          <div className="flex flex-col gap-[var(--space-4)]">
            {canReviewRequests ? <AccessRequestInbox showEmpty /> : null}
            {!canReviewRequests ? (
              <AccessNeededPanel destination={ACCESS_DESTINATION.ACCESS_ASSIGN} />
            ) : null}
            {!canReceiveMandateNotices ? (
              <AccessNeededPanel destination={ACCESS_DESTINATION.COMPLIANCE_NOTIFY} />
            ) : null}
          </div>
        ) : !canUsePeople ? (
          <div className="flex flex-col gap-[var(--space-4)]">
            <AccessNeededPanel destination={ACCESS_DESTINATION.ORGANIZATION} />
            {companyAccessTools && ownMember ? (
              <div className={listClass}>
                <Disclosure
                  title={<span className="font-medium">Your permissions</span>}
                  open={openId === ownMember.id}
                  onOpenChange={(open) => requestOpen(open ? ownMember.id : null)}
                >
                  {renderDetail(ownMember)}
                </Disclosure>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-[var(--space-3)]">
              <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                <input
                  type="search"
                  value={filter}
                  onChange={(event) => changeView(event.target.value, roleFilter)}
                  placeholder="Search by name or email"
                  aria-label="Search members"
                  className={`${fieldClass} min-w-0 basis-full sm:max-w-sm sm:flex-1 sm:basis-auto`}
                />
                {roleGroups.length > 1 ? (
                  <select
                    value={activeRoleFilter}
                    onChange={(event) => changeView(filter, event.target.value)}
                    aria-label="Filter by role"
                    className={`${fieldClass} pr-[var(--space-6)]`}
                  >
                    <option value="">All roles</option>
                    {roleGroups.map((group) => (
                      <option key={group.label} value={group.label}>
                        {`${group.label} (${group.members.length})`}
                      </option>
                    ))}
                  </select>
                ) : null}
                {showInviteOnRoster ? (
                  <span className="ml-auto">
                    <InvitePlusButton label={inviteLabel} onClick={() => setInviteOpen(true)} />
                  </span>
                ) : null}
              </div>
              {canBulk && members.some(isSelectable) ? (
                <div className="flex min-h-9 flex-wrap items-center gap-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                  <label className="flex items-center gap-[var(--space-2)] pl-[var(--space-3)]">
                    <input
                      type="checkbox"
                      className={checkboxClass}
                      checked={allShownSelected}
                      ref={(element) => {
                        if (element) element.indeterminate = someShownSelected && !allShownSelected;
                      }}
                      disabled={selectableShown.length === 0}
                      onChange={(event) => toggleAllShown(event.target.checked)}
                    />
                    <span>Select all shown</span>
                  </label>
                  {selectedMembers.length > 0 ? (
                    <span className="flex items-center gap-[var(--space-3)]">
                      <span aria-live="polite">{`${selectedMembers.length} selected`}</span>
                      <Button
                        size="sm"
                        onClick={() => {
                          // An open row would go stale under the bulk write: close it
                          // first. Unsaved edits ask; Discard then opens Set access.
                          if (openId !== null && dirtyId && dirtyId === openId) {
                            setPendingSwitch({ next: null, edit: false, bulk: true });
                            return;
                          }
                          if (openId !== null) requestOpen(null);
                          openBulk();
                        }}
                      >
                        Set access
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                        Clear
                      </Button>
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>

            <section aria-label="Members" className="flex flex-col gap-[var(--space-5)]">
              {members.length === 0 ? (
                // A failed read is not an empty roster: the alert above says so.
                error === ROSTER_LOAD_ERROR ? null : (
                  <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                    No members yet.
                  </p>
                )
              ) : visibleMembers.length === 0 ? (
                <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                  No members match.
                </p>
              ) : (
                visibleGroups.map((group) => {
                  const headingId = `role-group-${group.label.replace(/\W+/g, '-').toLowerCase()}`;
                  const allFixed = canBulk && group.members.every(isProtected);
                  return (
                    <div key={group.label} role="group" aria-labelledby={headingId} className="flex flex-col gap-[var(--space-2)]">
                      <h3
                        id={headingId}
                        className="flex items-baseline gap-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink)]"
                      >
                        {group.label}
                        <span className="font-mono text-[length:var(--text-xs)] font-normal text-[var(--ink-tertiary)]">
                          {group.members.length}
                        </span>
                        {allFixed ? (
                          <span className="text-[length:var(--text-xs)] font-normal text-[var(--ink-secondary)]">
                            Every permission, fixed
                          </span>
                        ) : null}
                      </h3>
                      <ul className={listClass}>{group.members.map(renderRow)}</ul>
                    </div>
                  );
                })
              )}
            </section>

            {invites.length > 0 ? (
              <section aria-label="Pending invites" className="flex flex-col gap-[var(--space-2)]">
                <h2 className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                  Pending invites
                </h2>
                {invites.map((invite) => (
                  <div
                    key={invite.id}
                    className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-dashed border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-3)] sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[length:var(--text-sm)] text-[var(--ink)]">
                        {invite.email}
                      </p>
                      <p className="truncate text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                        {companyRoleLabel(invite.companyRole, isExternalDirector)} ·{' '}
                        {invite.deliveryStatus} · expires{' '}
                        {formatDateTime(invite.expiresAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-[var(--space-2)]">
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass}
                        onClick={() => void resendInvite(invite)}
                      >
                        Resend
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className={buttonClass}
                        onClick={() =>
                          act(
                            () => fetch(`/api/v1/invites/${invite.id}`, { method: 'DELETE' }),
                            'The invite was not revoked.',
                          )
                        }
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
      {canSend ? (
        <InviteMemberDialog
          open={inviteOpen}
          onClose={() => {
            setInviteOpen(false);
            setPendingConfirm(null);
          }}
          email={inviteEmail}
          role={inviteRole}
          onEmailChange={(next) => {
            setInviteEmail(next);
            setPendingConfirm(null);
          }}
          onRoleChange={(next) => {
            setInviteRole(next);
            setPendingConfirm(null);
          }}
          canManage={canManage}
          isExternal={Boolean(viewer?.is_external)}
          busy={busy}
          pendingConfirm={pendingConfirm}
          onSubmit={submitInvite}
          onConfirmSend={() => {
            if (pendingConfirm) void sendInvite(pendingConfirm.confirmationId);
          }}
          onCancelConfirm={() => setPendingConfirm(null)}
        />
      ) : null}
      <Dialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={removing ? `Remove ${memberName(removing)}` : 'Remove'}
        description="Their access to this organization ends immediately, including their seats on deals."
        size="sm"
        dismissOnScrim={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const member = confirmRemove;
                if (!member) return;
                setConfirmRemove(null);
                void act(
                  () =>
                    fetch(`/api/v1/companies/${companyId}/members/${member.id}`, {
                      method: 'DELETE',
                    }),
                  'The removal was rejected.',
                );
              }}
            >
              Remove
            </Button>
          </>
        }
      />
      {canBulk ? (
        <BulkAccessDialog
          key={bulkRun}
          open={bulkOpen}
          onClose={() => setBulkOpen(false)}
          onFinished={() => setSelected(new Set())}
          companyId={companyId}
          people={selectedMembers.map((member) => ({
            id: member.id,
            name: memberName(member),
            access: memberAccess[member.id],
          }))}
          roles={rolesData.roles}
          permissions={rolesData.permissions}
          viewerPermissionKeys={targetCompanyGrantEnvelope}
          onAccessChange={onAccessChange}
        />
      ) : null}
    </div>
  );
}
