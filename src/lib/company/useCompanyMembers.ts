'use client';

import * as React from 'react';

import { team as fixtureTeam } from '@/lib/api/fixtures';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useFlag } from '@/lib/flags/FlagsContext';
import {
  COMPANY_ROLE_LABELS,
  DEAL_ROLE_LABELS,
  type CompanyRole,
  type DealRole,
} from '@/lib/constants/roles';

/** One colleague row for approver / assignee pickers. */
export type CompanyMemberOption = {
  id: string;
  name: string;
  role: string;
};

type ApiCompanyMember = {
  id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  department: string | null;
  company_role: string | null;
  preferred_deal_role: string | null;
};

export type CompanyMembersState =
  | { status: 'loading' }
  | { status: 'ready'; members: readonly CompanyMemberOption[] }
  | { status: 'error' };

function displayName(member: ApiCompanyMember): string {
  return member.display_name?.trim() || member.full_name?.trim() || member.email;
}

function roleLabel(member: ApiCompanyMember): string {
  const preferred = member.preferred_deal_role;
  if (preferred && preferred in DEAL_ROLE_LABELS) {
    return DEAL_ROLE_LABELS[preferred as DealRole];
  }
  if (member.department) return member.department.toUpperCase();
  if (member.company_role && member.company_role in COMPANY_ROLE_LABELS) {
    return COMPANY_ROLE_LABELS[member.company_role as CompanyRole];
  }
  return 'Colleague';
}

function mapMember(member: ApiCompanyMember): CompanyMemberOption {
  return {
    id: member.id,
    name: displayName(member),
    role: roleLabel(member),
  };
}

function fixtureMembers(): CompanyMemberOption[] {
  return fixtureTeam.map((m) => ({ id: m.id, name: m.name, role: m.role }));
}

/**
 * Company roster for in-product pickers (skip approver, assignees, etc.).
 * Flag on: GET /api/v1/companies/{companyId}/members (wall-filtered server-side).
 * Flag off: the demo fixture team.
 */
export function useCompanyMembers(): CompanyMembersState & {
  members: readonly CompanyMemberOption[];
} {
  const apiEnabled = useFlag('gate0_api_create');
  const { state } = useCurrentUser();
  const userReady = state.status === 'ready';
  const companyId = userReady ? state.data.user.company_id : null;
  const [fetchedByCompany, setFetchedByCompany] = React.useState<
    Record<string, Exclude<CompanyMembersState, { status: 'loading' }>>
  >({});

  const resolvedState = React.useMemo((): CompanyMembersState | null => {
    if (!apiEnabled) return { status: 'ready', members: fixtureMembers() };
    if (state.status === 'error') return { status: 'error' };
    if (!userReady) return { status: 'loading' };
    if (!companyId) return { status: 'ready', members: [] };
    return fetchedByCompany[companyId] ?? { status: 'loading' };
  }, [apiEnabled, state.status, userReady, companyId, fetchedByCompany]);

  React.useEffect(() => {
    if (!apiEnabled || !userReady || !companyId || fetchedByCompany[companyId]) return;

    let cancelled = false;

    void fetch(`/api/v1/companies/${companyId}/members`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`members: ${res.status}`);
        return (await res.json()) as { members?: ApiCompanyMember[] };
      })
      .then((body) => {
        if (cancelled) return;
        const members = (body.members ?? []).map(mapMember);
        setFetchedByCompany((current) => ({
          ...current,
          [companyId]: { status: 'ready', members },
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setFetchedByCompany((current) => ({
          ...current,
          [companyId]: { status: 'error' },
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [apiEnabled, userReady, companyId, fetchedByCompany]);

  const loadState = resolvedState ?? { status: 'loading' as const };
  const members =
    loadState.status === 'ready' ? loadState.members : loadState.status === 'error' ? [] : [];

  return { ...loadState, members };
}
