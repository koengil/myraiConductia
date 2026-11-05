'use client';

import * as React from 'react';

import type { CurrentUserProfile } from '@/lib/auth/useCurrentUser';
import { invalidateCompanyRoster } from '@/lib/company/companyRosterCache';
import {
  DEAL_ROLE_LABELS,
  DEPARTMENT,
  FIRM_ROLE,
  COMPANY_ROLE,
  INTERNAL_ASSIGNABLE_DEAL_ROLES,
  organizationRoleLabel,
  resolvePreferredDealRole,
  type InternalAssignableDealRole,
} from '@/lib/constants/roles';
import { useFlag } from '@/lib/flags/FlagsContext';

const ROW_CLASS =
  'grid gap-(--space-1) border-b border-[var(--stroke)] py-(--space-3) last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center sm:gap-(--space-4)';
const LABEL_CLASS = 'text-(length:--text-sm) font-medium text-ink-secondary';
const HINT_CLASS = 'text-(length:--text-xs) text-ink-tertiary';

const ROLE_HINT = 'Suggested when someone adds you to a deal.';
export const ROLE_SET_BY_DIRECTOR = 'A director at your firm sets this.';
export const ROLE_LOAD_ERROR = "Couldn't load your deal role.";
const NOT_SET = 'Not set';

/** Who has a preferred deal role at all: internal, non-walled people in a company (users_preferred_deal_role). */
function hasPreferredDealRole(user: CurrentUserProfile): boolean {
  const walled = user.department === DEPARTMENT.RESEARCH || user.department === DEPARTMENT.TRADING;
  return Boolean(user.company_id) && !user.is_external && !walled;
}

/** Mirrors canManageCompanyMembers for one's own company: a firm admin or the company's director. */
function canSetOwnPreferredDealRole(user: CurrentUserProfile): boolean {
  return user.firm_role === FIRM_ROLE.ADMIN || user.company_role === COMPANY_ROLE.DIRECTOR;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; role: InternalAssignableDealRole | null }
  | { status: 'error' };

/**
 * Profile › Role: the organization role (users.firm_role / company_role), as
 * read-only text through organizationRoleLabel, the same label the avatar
 * Popover shows. Nobody changes their own organization role here.
 *
 * Profile › Default deal role: the person's preferred deal role
 * (users.preferred_deal_role), the role suggested when someone adds them to a
 * deal. It grants nothing. Read from the company roster; changed through the
 * existing member PATCH (PATCH /api/v1/companies/{companyId}/members/{userId}
 * { preferredDealRole }), which only a director or firm admin may call, so
 * everyone else reads it. Shown only with platform_onboarding, to the people
 * the preference applies to.
 */
export function ProfileRoleField({
  user,
  onSaved,
}: {
  user: CurrentUserProfile;
  onSaved: (notice: string | null) => void;
}) {
  const enabled = useFlag('platform_onboarding') && hasPreferredDealRole(user);
  const canEdit = enabled && canSetOwnPreferredDealRole(user);
  const companyId = user.company_id;
  const [loaded, setLoaded] = React.useState<Loaded>({ status: 'loading' });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !companyId) return;
    let cancelled = false;
    fetch(`/api/v1/companies/${companyId}/members`, {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`members: ${res.status}`);
        return (await res.json()) as { members?: Array<{ id: string; preferred_deal_role: string | null }> };
      })
      .then((body) => {
        if (cancelled) return;
        const self = body.members?.find((m) => m.id === user.id);
        setLoaded(
          self
            ? { status: 'ready', role: resolvePreferredDealRole(self.preferred_deal_role) }
            : { status: 'error' },
        );
      })
      .catch(() => {
        if (!cancelled) setLoaded({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, companyId, user.id]);

  const roleRow = (
    <div className={ROW_CLASS} data-profile-field="role">
      <dt className={LABEL_CLASS}>Role</dt>
      <dd className="text-(length:--text-sm) text-ink">{organizationRoleLabel(user)}</dd>
    </div>
  );

  if (!enabled) return roleRow;

  const change = async (raw: string) => {
    if (loaded.status !== 'ready' || !companyId) return;
    const next = resolvePreferredDealRole(raw);
    const before = loaded.role;
    if (next === before) return;
    setError(null);
    onSaved(null);
    setSaving(true);
    setLoaded({ status: 'ready', role: next });
    try {
      const res = await fetch(`/api/v1/companies/${companyId}/members/${user.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ preferredDealRole: next }),
      });
      if (!res.ok) {
        throw new Error(
          res.status === 409
            ? 'Someone changed your default deal role just now. Reload to see it.'
            : 'The default deal role could not be saved. Try again.',
        );
      }
      invalidateCompanyRoster();
      onSaved('Default deal role saved.');
    } catch (err) {
      setLoaded({ status: 'ready', role: before });
      setError(err instanceof Error ? err.message : 'The default deal role could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const current = loaded.status === 'ready' ? loaded.role : null;

  return (
    <>
      {roleRow}
      <div className={ROW_CLASS} data-profile-field="default-deal-role">
        <dt className={LABEL_CLASS}>
          {canEdit ? <label htmlFor="profile-default-deal-role">Default deal role</label> : 'Default deal role'}
        </dt>
        <dd className="flex min-w-0 flex-col gap-(--space-1)">
          {loaded.status === 'loading' ? (
            <span className="text-(length:--text-sm) text-ink-tertiary">Loading…</span>
          ) : loaded.status === 'error' ? (
            <span role="alert" className="text-(length:--text-sm) text-ink-secondary">
              {ROLE_LOAD_ERROR}
            </span>
          ) : canEdit ? (
            <select
              id="profile-default-deal-role"
              value={current ?? ''}
              disabled={saving}
              aria-describedby="profile-default-deal-role-hint"
              onChange={(e) => void change(e.target.value)}
              className="h-9 w-full max-w-[16rem] rounded-input border border-transparent bg-[var(--surface-subtle)] px-(--space-3) text-(length:--text-sm) text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              <option value="">{NOT_SET}</option>
              {INTERNAL_ASSIGNABLE_DEAL_ROLES.map((role) => (
                <option key={role} value={role}>
                  {DEAL_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-(length:--text-sm) text-ink">
              {current ? DEAL_ROLE_LABELS[current] : NOT_SET}
            </span>
          )}
          {loaded.status === 'ready' ? (
            <span id="profile-default-deal-role-hint" className={HINT_CLASS}>
              {canEdit ? ROLE_HINT : `${ROLE_HINT} ${ROLE_SET_BY_DIRECTOR}`}
            </span>
          ) : null}
          {error ? (
            <span role="alert" className="text-(length:--text-sm) text-ink-secondary">
              {error}
            </span>
          ) : null}
        </dd>
      </div>
    </>
  );
}
