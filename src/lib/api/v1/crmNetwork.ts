import type { SupabaseClient } from '@supabase/supabase-js';

import { COMPANY_TYPE } from '@/lib/constants/companies';
import {
  buildCrmNetworkPayload,
  CLIENT_ORG_NETWORK_COLOR,
  type CrmNetworkPayload,
} from '@/lib/leads/crmNetwork';
import { dbFailure } from '@/lib/errors/upstream';

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Aggregate CRM people, lead maps, and warm paths into a network payload.
 * Scope mirrors GET /api/v1/crm-people and GET /api/v1/companies?type=client.
 */
export async function fetchCrmNetworkPayload(
  admin: SupabaseClient,
  tenantId: string,
  registrarCompanyId: string | null,
  tenantWide: boolean,
): Promise<CrmNetworkPayload> {
  let leadsBuilder = admin
    .from('companies')
    .select('id, name')
    .eq('tenant_id', tenantId)
    .eq('type', COMPANY_TYPE.CLIENT);
  if (!tenantWide && registrarCompanyId) {
    leadsBuilder = leadsBuilder.eq('registered_by_company_id', registrarCompanyId);
  }
  const { data: leads, error: leadsError } = await leadsBuilder.order('name').limit(100);
  if (leadsError) throw dbFailure('CRM leads lookup', leadsError);

  const leadRows = (leads ?? []).map((lead) => ({
    id: lead.id as string,
    name: lead.name as string,
  }));
  const leadIds = leadRows.map((lead) => lead.id);

  let clientCompany: { id: string; name: string } | null = null;
  if (registrarCompanyId) {
    const { data: clientRow, error: clientError } = await admin
      .from('companies')
      .select('id, name')
      .eq('id', registrarCompanyId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (clientError) throw dbFailure('CRM client lookup', clientError);
    if (clientRow) {
      clientCompany = {
        id: clientRow.id as string,
        name: clientRow.name as string,
      };
    }
  }

  if (leadIds.length === 0) {
    return {
      clientCompany: clientCompany
        ? {
            id: clientCompany.id,
            name: clientCompany.name,
            color: CLIENT_ORG_NETWORK_COLOR,
            kind: 'client' as const,
          }
        : null,
      companies: [],
      people: [],
      edges: [],
    };
  }

  let peopleBuilder = admin
    .from('crm_people')
    .select('id, name')
    .eq('tenant_id', tenantId);
  if (!tenantWide && registrarCompanyId) {
    peopleBuilder = peopleBuilder.eq('registered_by_company_id', registrarCompanyId);
  }
  const { data: people, error: peopleError } = await peopleBuilder.order('name').limit(200);
  if (peopleError) throw dbFailure('CRM people lookup', peopleError);

  const { data: stakeholders, error: stakeholdersError } = await admin
    .from('lead_stakeholders')
    .select('id, company_id, person_id, name')
    .eq('tenant_id', tenantId)
    .in('company_id', leadIds);
  if (stakeholdersError) throw dbFailure('CRM stakeholders lookup', stakeholdersError);

  const { data: relationships, error: relationshipsError } = await admin
    .from('lead_relationships')
    .select('id, company_id, person_id, person_name, relationship_type')
    .eq('tenant_id', tenantId)
    .in('company_id', leadIds);
  if (relationshipsError) throw dbFailure('CRM relationships lookup', relationshipsError);

  const { data: paths, error: pathsError } = await admin
    .from('lead_relationship_paths')
    .select('company_id, path_type, relationship_id, stakeholder_id')
    .eq('tenant_id', tenantId)
    .in('company_id', leadIds);
  if (pathsError) throw dbFailure('CRM paths lookup', pathsError);

  const peopleByName = new Map(
    (people ?? []).map((person) => [normalizeName(person.name as string), person.id as string]),
  );

  const stakeholderPersonIds = new Map<string, string>();
  for (const row of stakeholders ?? []) {
    const id = row.id as string;
    const companyId = row.company_id as string;
    const nameKey = `${companyId}:${normalizeName(row.name as string)}`;
    const personId = (row.person_id as string | null) ?? null;
    if (personId) {
      stakeholderPersonIds.set(id, personId);
      stakeholderPersonIds.set(nameKey, personId);
      continue;
    }
    const resolved = peopleByName.get(normalizeName(row.name as string));
    if (resolved) {
      stakeholderPersonIds.set(id, resolved);
      stakeholderPersonIds.set(nameKey, resolved);
    }
  }

  const relationshipPersonIds = new Map<string, string>();
  const relationshipNameKeys = new Map<string, string>();
  for (const row of relationships ?? []) {
    const id = row.id as string;
    const personId = (row.person_id as string | null) ?? null;
    if (personId) {
      relationshipPersonIds.set(id, personId);
      relationshipNameKeys.set(
        `${row.company_id as string}:${normalizeName(row.person_name as string)}`,
        personId,
      );
      continue;
    }
    const resolved = peopleByName.get(normalizeName(row.person_name as string));
    if (resolved) {
      relationshipPersonIds.set(id, resolved);
      relationshipNameKeys.set(
        `${row.company_id as string}:${normalizeName(row.person_name as string)}`,
        resolved,
      );
    }
  }

  return buildCrmNetworkPayload({
    leads: leadRows,
    clientCompany,
    people: (people ?? []).map((person) => ({
      id: person.id as string,
      name: person.name as string,
    })),
    stakeholders: (stakeholders ?? []).map((row) => ({
      company_id: row.company_id as string,
      person_id: (row.person_id as string | null) ?? null,
      name: row.name as string,
    })),
    relationships: (relationships ?? []).map((row) => ({
      company_id: row.company_id as string,
      person_id: (row.person_id as string | null) ?? null,
      person_name: row.person_name as string,
      relationship_type: (row.relationship_type as string | null) ?? null,
    })),
    paths: (paths ?? []).map((row) => ({
      company_id: row.company_id as string,
      path_type: row.path_type as string,
      relationship_id: (row.relationship_id as string | null) ?? null,
      stakeholder_id: row.stakeholder_id as string,
    })),
    stakeholderPersonIds,
    relationshipPersonIds: new Map([...relationshipPersonIds, ...relationshipNameKeys]),
  });
}
