'use client';

import * as React from 'react';

import {
  useCompanyMembers,
  type CompanyMemberOption,
  type CompanyMembersState,
} from '@/lib/company/useCompanyMembers';
import { SKIP_APPROVER_DEAL_ROLES } from '@/lib/constants/dealSteps';
import { DEAL_ROLE_LABELS, type DealRole } from '@/lib/constants/roles';
import { USER_STATUS } from '@/lib/constants/users';

type StepMember = { id: string; name: string; dealRole: string; status?: string | null };

type LoadedState = Exclude<CompanyMembersState, { status: 'loading' }>;

function isApproverRole(role: string): role is DealRole {
  return (SKIP_APPROVER_DEAL_ROLES as readonly string[]).includes(role);
}

function toApprovers(members: readonly StepMember[]): CompanyMemberOption[] {
  return members.flatMap((member) =>
    member.id && member.status === USER_STATUS.ACTIVE && isApproverRole(member.dealRole)
      ? [{ id: member.id, name: member.name, role: DEAL_ROLE_LABELS[member.dealRole] }]
      : [],
  );
}

/**
 * Who the Skip modal offers as approver (#312).
 * Live deals: the deal's seats from GET /api/v1/deals/{dealId}/steps/{stepKey},
 * kept to active users in SKIP_APPROVER_DEAL_ROLES, as resolveSkipApprover requires.
 * Fixture deals: the company roster, since nothing reaches the server there.
 */
export function useSkipApprovers({
  dealId,
  stepKey,
  live,
}: {
  dealId: string;
  stepKey: string;
  live: boolean;
}): CompanyMembersState & { members: readonly CompanyMemberOption[] } {
  const company = useCompanyMembers();
  const key = `${dealId}:${stepKey}`;
  const [fetchedByStep, setFetchedByStep] = React.useState<Record<string, LoadedState>>({});

  React.useEffect(() => {
    if (!live || fetchedByStep[key]) return;

    let cancelled = false;

    void fetch(
      `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${encodeURIComponent(stepKey)}`,
      { credentials: 'include', headers: { Accept: 'application/json' } },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`step: ${res.status}`);
        return (await res.json()) as { members?: StepMember[] };
      })
      .then((body) => {
        if (cancelled) return;
        const members = toApprovers(body.members ?? []);
        setFetchedByStep((current) => ({ ...current, [key]: { status: 'ready', members } }));
      })
      .catch(() => {
        if (cancelled) return;
        setFetchedByStep((current) => ({ ...current, [key]: { status: 'error' } }));
      });

    return () => {
      cancelled = true;
    };
  }, [live, key, dealId, stepKey, fetchedByStep]);

  if (!live) return company;
  const loadState = fetchedByStep[key] ?? { status: 'loading' as const };
  return { ...loadState, members: loadState.status === 'ready' ? loadState.members : [] };
}
