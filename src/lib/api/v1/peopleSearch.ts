import type { SupabaseClient } from '@supabase/supabase-js';

import { userCanAccessDeal, userCanSearchCompanies, userCanViewLeads } from '@/lib/api/v1/access';
import { emailFromContactInfo } from '@/lib/api/v1/crmPeople';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import {
  PERSON_SEARCH_SCOPE,
  PERSON_SUGGESTION_SOURCE,
  type PersonSearchScope,
  type PersonSuggestion,
} from '@/lib/people/types';

const MAX_RESULTS = 15;
const MIN_QUERY_LEN = 2;

function actorName(user: {
  display_name?: string | null;
  full_name?: string | null;
  email?: string | null;
}) {
  return user.display_name?.trim() || user.full_name?.trim() || user.email?.trim() || 'Member';
}

function dedupeKey(suggestion: PersonSuggestion): string {
  if (suggestion.email) return `e:${suggestion.email.toLowerCase()}`;
  return `n:${suggestion.name.toLowerCase()}`;
}

function matchesQuery(query: string, ...parts: Array<string | null | undefined>): boolean {
  const needle = query.toLowerCase();
  return parts.some((part) => part?.toLowerCase().includes(needle));
}

function pushSuggestion(
  bucket: Map<string, PersonSuggestion>,
  suggestion: PersonSuggestion,
): void {
  const key = dedupeKey(suggestion);
  if (!bucket.has(key)) bucket.set(key, suggestion);
}

export type SearchPeopleOptions = {
  query: string;
  dealId?: string | null;
  companyId?: string | null;
  scope?: PersonSearchScope;
};

/**
 * Tenant-scoped people search for mail recipients and rail person-name fields.
 * Merges deal roster, company users, and lead CRM contacts the actor may see.
 */
export async function searchPeople(
  admin: SupabaseClient,
  actorId: string,
  options: SearchPeopleOptions,
): Promise<PersonSuggestion[]> {
  const query = options.query.trim();

  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('tenant_id, company_id')
    .eq('id', actorId)
    .single();
  if (profileError || !profile) return [];

  if (options.scope === PERSON_SEARCH_SCOPE.COMPANY_EMPLOYEES) {
    if (!profile.company_id) return [];
    const companyId = profile.company_id as string;

    const { data: company } = await admin
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .eq('tenant_id', profile.tenant_id as string)
      .maybeSingle();
    if (!company) return [];

    let builder = admin
      .from('users')
      .select('id, display_name, full_name, email')
      .eq('tenant_id', profile.tenant_id as string)
      .eq('company_id', companyId)
      .eq('status', 'active')
      .limit(50);

    if (query.length >= MIN_QUERY_LEN) {
      builder = builder.or(
        `display_name.ilike.%${query}%,full_name.ilike.%${query}%,email.ilike.%${query}%`,
      );
    }

    const { data: companyUsers } = await builder;
    const results: PersonSuggestion[] = [];
    for (const user of companyUsers ?? []) {
      const name = actorName(user);
      const email = user.email?.trim().toLowerCase() ?? null;
      if (query.length >= MIN_QUERY_LEN && !matchesQuery(query, name, email)) continue;
      results.push({
        id: `company-user:${user.id}`,
        name,
        email,
        company: company.name as string,
        source: PERSON_SUGGESTION_SOURCE.COMPANY_USER,
      });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_RESULTS);
  }

  if (query.length < MIN_QUERY_LEN) return [];

  const tenantId = profile.tenant_id as string;
  const firmNetworkOnly = options.scope === PERSON_SEARCH_SCOPE.FIRM_NETWORK;
  const results = new Map<string, PersonSuggestion>();
  const companyIds = new Set<string>();

  if (options.companyId) companyIds.add(options.companyId);
  if (profile.company_id) companyIds.add(profile.company_id as string);

  if (options.dealId) {
    try {
      const deal = await loadDealByIdOrCode(admin, options.dealId);
      if (deal && (await userCanAccessDeal(admin, actorId, deal.id))) {

        const { data: members } = await admin
          .from('deal_memberships')
          .select(
            'deal_role, user:users!deal_memberships_user_id_fkey(id, display_name, full_name, email)',
          )
          .eq('deal_id', deal.id);

        type MemberUser = {
          id?: string;
          display_name?: string | null;
          full_name?: string | null;
          email?: string | null;
        };

        for (const row of members ?? []) {
          const raw = row.user as MemberUser | MemberUser[] | null;
          const user = Array.isArray(raw) ? raw[0] : raw;
          if (!user?.id) continue;
          const name = actorName(user);
          const email = user.email?.trim().toLowerCase() ?? null;
          if (!matchesQuery(query, name, email)) continue;
          pushSuggestion(results, {
            id: `deal-member:${user.id}`,
            name,
            email,
            company: null,
            source: PERSON_SUGGESTION_SOURCE.DEAL_MEMBER,
          });
        }

        const { data: parties } = await admin
          .from('deal_parties')
          .select('company_id')
          .eq('deal_id', deal.id);
        for (const party of parties ?? []) {
          if (party.company_id) companyIds.add(party.company_id as string);
        }
      }
    } catch {
      // Unknown deal id — continue with company-scoped sources only.
    }
  }

  for (const companyId of companyIds) {
    const { data: company } = await admin
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!company) continue;

    const { data: companyUsers } = await admin
      .from('users')
      .select('id, display_name, full_name, email')
      .eq('tenant_id', tenantId)
      .eq('company_id', companyId)
      .eq('status', 'active')
      .limit(40);

    for (const user of companyUsers ?? []) {
      const name = actorName(user);
      const email = user.email?.trim().toLowerCase() ?? null;
      if (!matchesQuery(query, name, email)) continue;
      pushSuggestion(results, {
        id: `company-user:${user.id}`,
        name,
        email,
        company: company.name as string,
        source: PERSON_SUGGESTION_SOURCE.COMPANY_USER,
      });
    }

    if (!(await userCanViewLeads(admin, actorId))) continue;

    const { data: relationships } = await admin
      .from('lead_relationships')
      .select('id, person_name, person_company, contact_info')
      .eq('tenant_id', tenantId)
      .eq('company_id', companyId)
      .ilike('person_name', `%${query}%`)
      .limit(20);

    for (const rel of relationships ?? []) {
      const name = rel.person_name?.trim();
      if (!name) continue;
      pushSuggestion(results, {
        id: `relationship:${rel.id}`,
        name,
        email: emailFromContactInfo(rel.contact_info as string | null),
        company: (rel.person_company as string | null) ?? (company.name as string),
        source: PERSON_SUGGESTION_SOURCE.RELATIONSHIP,
      });
    }

    if (!firmNetworkOnly) {
      const { data: stakeholders } = await admin
        .from('lead_stakeholders')
        .select('id, name, org')
        .eq('tenant_id', tenantId)
        .eq('company_id', companyId)
        .ilike('name', `%${query}%`)
        .limit(20);

      for (const row of stakeholders ?? []) {
        const name = row.name?.trim();
        if (!name) continue;
        pushSuggestion(results, {
          id: `stakeholder:${row.id}`,
          name,
          email: null,
          company: (row.org as string | null) ?? (company.name as string),
          source: PERSON_SUGGESTION_SOURCE.STAKEHOLDER,
        });
      }
    }
  }

  if (await userCanViewLeads(admin, actorId)) {
    const tenantWide = await userCanSearchCompanies(admin, actorId);
    let crmBuilder = admin
      .from('crm_people')
      .select('id, name, email, org')
      .eq('tenant_id', tenantId)
      .or(`name.ilike.%${query}%,email.ilike.%${query}%`)
      .limit(20);
    if (!tenantWide && profile.company_id) {
      crmBuilder = crmBuilder.eq('registered_by_company_id', profile.company_id as string);
    }

    const { data: crmPeople } = await crmBuilder;
    for (const row of crmPeople ?? []) {
      const name = row.name?.trim();
      if (!name) continue;
      pushSuggestion(results, {
        id: `crm-person:${row.id}`,
        name,
        email: (row.email as string | null)?.trim().toLowerCase() ?? null,
        company: (row.org as string | null) ?? null,
        source: PERSON_SUGGESTION_SOURCE.CRM_PERSON,
      });
    }
  }

  return Array.from(results.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_RESULTS);
}
