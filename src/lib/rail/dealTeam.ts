'use client';

import * as React from 'react';

import {
  DEALS_EVENT,
  resolveDeal,
  type DealTeamGrant,
  type FixtureDeal,
} from '@/lib/rail/deals';

const PERSONA_BY_ID: Record<string, { name: string; initials: string }> = {
  sd: { name: 'Storm Duncan', initials: 'SD' },
  jw: { name: 'James Watt', initials: 'JW' },
  sr: { name: 'Sarah Reid', initials: 'SR' },
  pm: { name: 'Priya Mehta', initials: 'PM' },
  tc: { name: 'Tom Clarke', initials: 'TC' },
};

export type ResolvedTeamMember = {
  id: string;
  name: string;
  role: string;
  initials: string;
  addedBy: string;
  addedOn: string;
};

export type DealTeamRosterView = {
  intake: ResolvedTeamMember[];
  later: ResolvedTeamMember[];
  /** Gate 0 team step is satisfied when at least one member was assigned at intake. */
  isComplete: boolean;
};

function localDateFromIso(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolveGrant(grant: DealTeamGrant): ResolvedTeamMember {
  const persona = PERSONA_BY_ID[grant.id];
  return {
    id: grant.id,
    role: grant.role,
    name: persona?.name ?? grant.id,
    initials: persona?.initials ?? grant.id.slice(0, 2).toUpperCase(),
    addedBy: grant.addedBy,
    addedOn: grant.addedOn,
  };
}

/** Build intake grants from legacy `team` when older records lack `teamIntake`. */
function legacyIntakeGrants(deal: FixtureDeal): DealTeamGrant[] {
  if (!deal.team?.length) return [];
  const addedBy = deal.createdBy?.trim() || 'Storm Duncan';
  const addedOn = localDateFromIso(deal.createdAt) || '2026-01-01';
  return deal.team.map((m) => ({ ...m, addedBy, addedOn }));
}

/** Resolve the deal team roster with provenance for intake and later additions. */
export function resolveDealTeamRoster(deal: FixtureDeal): DealTeamRosterView {
  const intakeGrants = deal.teamIntake?.length ? deal.teamIntake : legacyIntakeGrants(deal);
  const intake = intakeGrants.map(resolveGrant);
  const later = (deal.teamLater ?? []).map(resolveGrant);
  return {
    intake,
    later,
    isComplete: intake.length > 0,
  };
}

function rosterForDealId(dealId: string): DealTeamRosterView {
  const deal = resolveDeal(dealId);
  return deal
    ? resolveDealTeamRoster(deal)
    : { intake: [], later: [], isComplete: false };
}

/** Live roster view for a deal id — refreshes when the fixture store changes. */
export function useDealTeamRoster(dealId: string): DealTeamRosterView {
  const [roster, setRoster] = React.useState(() => rosterForDealId(dealId));

  React.useEffect(() => {
    const refresh = () => setRoster(rosterForDealId(dealId));
    refresh();
    window.addEventListener(DEALS_EVENT, refresh);
    return () => window.removeEventListener(DEALS_EVENT, refresh);
  }, [dealId]);

  return roster;
}
