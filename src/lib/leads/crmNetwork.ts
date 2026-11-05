/** Live CRM network payload for the /leads Network tab. */

export type CrmNetworkCompanyKind = 'client' | 'lead';

export type CrmNetworkCompany = {
  id: string;
  name: string;
  color: string;
  kind?: CrmNetworkCompanyKind;
};

export type CrmNetworkPerson = {
  id: string;
  name: string;
  /** Cluster color — client org for employees, lead company for stakeholders. */
  companyId: string;
  /** Lead map to open when the node is clicked. */
  leadId: string;
};

export type CrmNetworkEdgeKind = 'warm_path' | 'relationship';

export type CrmNetworkEdge = {
  from: string;
  to: string;
  kind: CrmNetworkEdgeKind;
  label?: string;
};

export type CrmNetworkPayload = {
  /** The caller's customer org (relationship / employee cluster). */
  clientCompany: CrmNetworkCompany | null;
  /** Registered lead companies (stakeholder clusters). */
  companies: CrmNetworkCompany[];
  people: CrmNetworkPerson[];
  edges: CrmNetworkEdge[];
};

export type CrmNetworkLeadRow = {
  id: string;
  name: string;
};

export type CrmNetworkStakeholderRow = {
  company_id: string;
  person_id: string | null;
  name: string;
};

export type CrmNetworkRelationshipRow = {
  company_id: string;
  person_id: string | null;
  person_name: string;
  relationship_type: string | null;
};

export type CrmNetworkPathRow = {
  company_id: string;
  path_type: string;
  relationship_id: string | null;
  stakeholder_id: string;
};

export type CrmNetworkPersonRow = {
  id: string;
  name: string;
};

/**
 * Workbench categorical data-viz scale (--viz-client, --viz-1 … --viz-8 in
 * docs/design/workbench/tokens.css and the workbench block of
 * src/app/globals.css). Kept as hex here because the colour travels in the
 * /api/v1/crm-network payload and the graph derives alpha tints from it
 * (`${color}33`), which a var() reference cannot do. A test pins these values
 * to both CSS files. Muted, no violet (reserved for Casey), no status hue;
 * labels carry identity, colour only groups.
 */
export const VIZ_CLIENT_COLOR = '#66635c';

export const VIZ_CATEGORICAL_COLORS = [
  '#2f7d78',
  '#a8553a',
  '#2b6f86',
  '#827a2c',
  '#a3476b',
  '#4a7a40',
  '#7f6252',
  '#5f7330',
] as const;

export const CLIENT_ORG_NETWORK_COLOR = VIZ_CLIENT_COLOR;

const LEAD_COMPANY_COLORS = VIZ_CATEGORICAL_COLORS;

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function edgeKey(from: string, to: string): string {
  return from < to ? `${from}|${to}` : `${to}|${from}`;
}

/** Deterministic colors for lead company clusters. */
export function companyColorsForLeads(leads: CrmNetworkLeadRow[]): Map<string, string> {
  const sorted = [...leads].sort((a, b) => a.name.localeCompare(b.name));
  return new Map(
    sorted.map((lead, index) => [lead.id, LEAD_COMPANY_COLORS[index % LEAD_COMPANY_COLORS.length]]),
  );
}

type PersonLeadBinding = {
  personId: string;
  companyId: string;
  leadId: string;
  priority: number;
};

/**
 * Build the tenant/org-scoped network graph from CRM catalog rows.
 * Stakeholders cluster on their lead; relationship contacts cluster on the client org.
 */
export function buildCrmNetworkPayload(input: {
  leads: CrmNetworkLeadRow[];
  clientCompany: CrmNetworkLeadRow | null;
  people: CrmNetworkPersonRow[];
  stakeholders: CrmNetworkStakeholderRow[];
  relationships: CrmNetworkRelationshipRow[];
  paths: CrmNetworkPathRow[];
  stakeholderPersonIds: Map<string, string>;
  relationshipPersonIds: Map<string, string>;
}): CrmNetworkPayload {
  const leadIds = new Set(input.leads.map((lead) => lead.id));
  const leadColors = companyColorsForLeads(input.leads);
  const peopleById = new Map(input.people.map((person) => [person.id, person]));
  const bindings = new Map<string, PersonLeadBinding>();
  const clientCompanyId = input.clientCompany?.id ?? null;

  function bindPerson(
    personId: string,
    companyId: string,
    leadId: string,
    priority: number,
  ) {
    if (!leadIds.has(leadId) && leadId !== clientCompanyId) return;
    const existing = bindings.get(personId);
    if (!existing || priority < existing.priority) {
      bindings.set(personId, { personId, companyId, leadId, priority });
    }
  }

  for (const stakeholder of input.stakeholders) {
    const personId =
      stakeholder.person_id ??
      input.stakeholderPersonIds.get(`${stakeholder.company_id}:${normalizeName(stakeholder.name)}`);
    if (!personId) continue;
    bindPerson(personId, stakeholder.company_id, stakeholder.company_id, 0);
  }

  for (const relationship of input.relationships) {
    const personId =
      relationship.person_id ??
      input.relationshipPersonIds.get(
        `${relationship.company_id}:${normalizeName(relationship.person_name)}`,
      );
    if (!personId) continue;
    const clusterCompanyId = clientCompanyId ?? relationship.company_id;
    bindPerson(personId, clusterCompanyId, relationship.company_id, 1);
  }

  const networkPeople: CrmNetworkPerson[] = [...bindings.values()]
    .map((binding) => {
      const person = peopleById.get(binding.personId);
      if (!person) return null;
      return {
        id: person.id,
        name: person.name,
        companyId: binding.companyId,
        leadId: binding.leadId,
      };
    })
    .filter((person): person is CrmNetworkPerson => person != null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const personIds = new Set(networkPeople.map((person) => person.id));
  const edges = new Map<string, CrmNetworkEdge>();

  for (const path of input.paths) {
    if (path.path_type !== 'warm' || !path.relationship_id) continue;
    const fromPersonId = input.stakeholderPersonIds.get(path.stakeholder_id);
    const toPersonId = input.relationshipPersonIds.get(path.relationship_id);
    if (!fromPersonId || !toPersonId) continue;
    if (!personIds.has(fromPersonId) || !personIds.has(toPersonId)) continue;
    const key = edgeKey(fromPersonId, toPersonId);
    if (edges.has(key)) continue;
    edges.set(key, {
      from: fromPersonId,
      to: toPersonId,
      kind: 'warm_path',
      label: 'warm path',
    });
  }

  for (const relationship of input.relationships) {
    const personId =
      relationship.person_id ??
      input.relationshipPersonIds.get(
        `${relationship.company_id}:${normalizeName(relationship.person_name)}`,
      );
    if (!personId || !personIds.has(personId)) continue;
    if (!leadIds.has(relationship.company_id)) continue;
    const key = `relationship|${personId}|${relationship.company_id}`;
    if (edges.has(key)) continue;
    edges.set(key, {
      from: personId,
      to: relationship.company_id,
      kind: 'relationship',
      label: relationship.relationship_type ?? undefined,
    });
  }

  const leadCompanyIds = new Set<string>();
  for (const person of networkPeople) {
    if (clientCompanyId && person.companyId === clientCompanyId) {
      if (person.leadId !== clientCompanyId) {
        leadCompanyIds.add(person.leadId);
      }
      continue;
    }
    leadCompanyIds.add(person.companyId);
  }

  const companies = input.leads
    .filter((lead) => leadCompanyIds.has(lead.id))
    .map((lead) => ({
      id: lead.id,
      name: lead.name,
      color: leadColors.get(lead.id) ?? '#64748b',
      kind: 'lead' as const,
    }));

  const clientCompany =
    input.clientCompany &&
    networkPeople.some((person) => person.companyId === input.clientCompany!.id)
      ? {
          id: input.clientCompany.id,
          name: input.clientCompany.name,
          color: CLIENT_ORG_NETWORK_COLOR,
          kind: 'client' as const,
        }
      : input.clientCompany
        ? {
            id: input.clientCompany.id,
            name: input.clientCompany.name,
            color: CLIENT_ORG_NETWORK_COLOR,
            kind: 'client' as const,
          }
        : null;

  return {
    clientCompany,
    companies,
    people: networkPeople,
    edges: [...edges.values()],
  };
}

/** All company clusters for layout and legend (client org first). */
export function networkClusterCompanies(
  payload: CrmNetworkPayload,
): CrmNetworkCompany[] {
  return [
    ...(payload.clientCompany ? [payload.clientCompany] : []),
    ...payload.companies,
  ];
}
