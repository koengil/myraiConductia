import type { SupabaseClient } from '@supabase/supabase-js';

import { isUuid } from '@/lib/api/v1/http';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import { dbFailure } from '@/lib/errors/upstream';

export type ConductiaContact = {
  contactId: string;
  displayName: string;
  org: string | null;
  title: string | null;
  isSource: boolean;
  side: 'internal' | 'external' | null;
  updatedAt: string | null;
};

export type ConductiaLead = {
  tenantId: string;
  /**
   * The Conductia per-firm tenant uuid that actually owns this lead, from
   * `deals.tenant_id` (deal leads) or `companies.tenant_id` (company leads).
   *
   * NOT resolveLeadCompany's tenant: for a deal that returns the TARGET
   * company's tenant, and a target of type `bank` is minted its own tenant at
   * onboard, so the two can differ. deals.tenant_id owns the mandate.
   */
  ownerTenantId: string | null;
  leadId: string;
  version: number;
  clientName: string | null;
  record: {
    clientGoals: {
      whySelling: null;
      priceExpectation: null;
      timingExpectation: null;
      mustHaves: null;
    };
    decisionCriteria: [];
    competingBanks: [];
    winProbability: null;
    preliminaryPitchAngle: { whyUs: null; clientStory: null };
  };
  claims: [];
  sources: [];
  contacts: ConductiaContact[];
  changeTracking: {
    available: false;
    omittedPaths: [];
    authorities: [];
    recentChanges: [];
    historyDepth: null;
    retrievedAt: null;
    unavailableReason: string;
  };
  ownerUserId: string | null;
  updatedAt: string | null;
};

type StakeholderRow = {
  id: string;
  name: string | null;
  title: string | null;
  org: string | null;
  created_at: string | null;
};

type MemberRow = {
  user: { id: string; display_name: string | null; full_name: string | null } | null;
};

export async function loadConductiaLead(
  admin: SupabaseClient,
  leadId: string,
  tenantId: string,
): Promise<ConductiaLead | null> {
  const dealRef = await loadDealByIdOrCode(admin, leadId);
  if (!dealRef) {
    return loadConductiaLeadFromCompany(admin, leadId, tenantId);
  }

  const { data: deal, error: dealError } = await admin
    .from('deals')
    .select('id, code, codename, mandate_owner_id, created_at, tenant_id')
    .eq('id', dealRef.id)
    .maybeSingle();
  if (dealError) throw dbFailure('Lead deal lookup', dealError);
  if (!deal) return null;

  const { data: parties, error: partiesError } = await admin
    .from('deal_parties')
    .select('party_role, company:companies(id, name)')
    .eq('deal_id', deal.id);
  if (partiesError) throw dbFailure('Lead parties lookup', partiesError);

  const target = (parties ?? []).find((row) => row.party_role === 'target');
  const company = unwrap(target?.company);
  const clientName = company?.name?.trim() || deal.codename?.trim() || null;

  const contacts: ConductiaContact[] = [];
  const seen = new Set<string>();

  if (company?.id) {
    const { data: stakeholders, error: stakeholderError } = await admin
      .from('lead_stakeholders')
      .select('id, name, title, org, created_at')
      .eq('company_id', company.id)
      .order('created_at', { ascending: false });
    if (stakeholderError) throw dbFailure('Lead stakeholders lookup', stakeholderError);

    for (const row of (stakeholders ?? []) as StakeholderRow[]) {
      const displayName = row.name?.trim();
      if (!displayName) continue;
      const key = displayName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      contacts.push({
        contactId: row.id,
        displayName,
        org: row.org?.trim() || clientName,
        title: row.title?.trim() || null,
        isSource: false,
        side: 'external',
        updatedAt: toIso(row.created_at),
      });
    }
  }

  const { data: members, error: membersError } = await admin
    .from('deal_memberships')
    .select('user:users!deal_memberships_user_id_fkey(id, display_name, full_name)')
    .eq('deal_id', deal.id);
  if (membersError) throw dbFailure('Lead members lookup', membersError);

  for (const row of (members ?? []) as unknown as MemberRow[]) {
    const user = unwrap(row.user);
    const displayName = user?.display_name?.trim() || user?.full_name?.trim();
    if (!user?.id || !displayName) continue;
    const key = displayName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    contacts.push({
      contactId: user.id,
      displayName,
      org: 'Conductia',
      title: 'Deal team',
      isSource: false,
      side: 'internal',
      updatedAt: null,
    });
  }

  return {
    tenantId,
    ownerTenantId: (deal.tenant_id as string | null) ?? null,
    leadId,
    version: 1,
    clientName,
    record: emptyRecord(),
    claims: [],
    sources: [],
    contacts,
    changeTracking: {
      available: false,
      omittedPaths: [],
      authorities: [],
      recentChanges: [],
      historyDepth: null,
      retrievedAt: null,
      unavailableReason: 'Intellibank does not expose change tracking on this seam.',
    },
    ownerUserId: deal.mandate_owner_id || null,
    updatedAt: toIso(deal.created_at),
  };
}

async function loadConductiaLeadFromCompany(
  admin: SupabaseClient,
  companyId: string,
  tenantId: string,
): Promise<ConductiaLead | null> {
  // companies.id is a uuid, so Postgres rejects anything else outright. A
  // deal code nobody holds is simply not a lead, and it must answer the same
  // 404 as another firm's deal code, not a 500 that tells the two apart.
  if (!isUuid(companyId)) return null;
  const { data: company, error } = await admin
    .from('companies')
    .select('id, name, created_at, tenant_id')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw dbFailure('Lead company lookup', error);
  if (!company) return null;

  const clientName = company.name?.trim() || null;
  const contacts: ConductiaContact[] = [];
  const seen = new Set<string>();

  const { data: stakeholders, error: stakeholderError } = await admin
    .from('lead_stakeholders')
    .select('id, name, title, org, created_at')
    .eq('company_id', company.id)
    .order('created_at', { ascending: false });
  if (stakeholderError) throw dbFailure('Lead stakeholders lookup', stakeholderError);

  for (const row of (stakeholders ?? []) as StakeholderRow[]) {
    const displayName = row.name?.trim();
    if (!displayName) continue;
    const key = displayName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    contacts.push({
      contactId: row.id,
      displayName,
      org: row.org?.trim() || clientName,
      title: row.title?.trim() || null,
      isSource: false,
      side: 'external',
      updatedAt: toIso(row.created_at),
    });
  }

  return {
    tenantId,
    ownerTenantId: (company.tenant_id as string | null) ?? null,
    leadId: companyId,
    version: 1,
    clientName,
    record: emptyRecord(),
    claims: [],
    sources: [],
    contacts,
    changeTracking: {
      available: false,
      omittedPaths: [],
      authorities: [],
      recentChanges: [],
      historyDepth: null,
      retrievedAt: null,
      unavailableReason: 'Intellibank does not expose change tracking on this seam.',
    },
    ownerUserId: null,
    updatedAt: toIso(company.created_at as string | null),
  };
}

export function emptyRecord(): ConductiaLead['record'] {
  return {
    clientGoals: {
      whySelling: null,
      priceExpectation: null,
      timingExpectation: null,
      mustHaves: null,
    },
    decisionCriteria: [],
    competingBanks: [],
    winProbability: null,
    preliminaryPitchAngle: { whyUs: null, clientStory: null },
  };
}

function unwrap<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
