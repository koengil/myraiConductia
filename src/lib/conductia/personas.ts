import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { dbFailure } from '@/lib/errors/upstream';

export type StoredPersona = {
  personaId: string;
  /** Ignatious control-plane handle ("tn_demo"). Not an isolation boundary. */
  tenantId: string;
  /**
   * Conductia per-firm tenant uuid. THIS is the isolation boundary: the handle
   * above is one constant per deployment, so every firm shares it.
   */
  conductiaTenantId: string | null;
  name: string;
  title: string;
  organization: string;
  type: string | null;
  subtype: string | null;
  tags: string[];
  body: string;
  version: number;
  authoredBy: 'human' | 'agent';
  linkedContacts: { tenantId: string; leadId: string; contactId: string }[];
  evidence: unknown[];
  history: unknown[];
  updatedAt: string;
};

export async function listPersonas(
  admin: SupabaseClient,
  tenantId: string,
  conductiaTenantId: string,
  filter?: { linkedLeadId?: string },
): Promise<StoredPersona[]> {
  const { data, error } = await admin
    .from(TABLE.LEAD_PERSONAS)
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('conductia_tenant_id', conductiaTenantId)
    .order('updated_at', { ascending: false });
  if (error) throw dbFailure('Persona list', error);
  const all = (data ?? []).map(rowToPersona);
  if (!filter?.linkedLeadId) return all;
  return all.filter((persona) =>
    persona.linkedContacts.some((link) => link.leadId === filter.linkedLeadId),
  );
}

export async function getPersona(
  admin: SupabaseClient,
  tenantId: string,
  conductiaTenantId: string,
  personaId: string,
): Promise<StoredPersona | null> {
  const { data, error } = await admin
    .from(TABLE.LEAD_PERSONAS)
    .select('*')
    .eq('id', personaId)
    .eq('tenant_id', tenantId)
    .eq('conductia_tenant_id', conductiaTenantId)
    .maybeSingle();
  if (error) throw dbFailure('Persona read', error);
  return data ? rowToPersona(data as Record<string, unknown>) : null;
}

export async function createPersona(
  admin: SupabaseClient,
  tenantId: string,
  conductiaTenantId: string,
  body: Record<string, unknown>,
): Promise<StoredPersona> {
  const personaId = `per_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  // The link tenant is stamped from scope, never the caller's, as in linkPersona.
  const link = isLink(body.link)
    ? [{ tenantId, leadId: body.link.leadId, contactId: body.link.contactId }]
    : [];
  const persona: StoredPersona = {
    personaId,
    tenantId,
    conductiaTenantId,
    name: String(body.name ?? 'Unknown'),
    title: String(body.title ?? 'Unknown'),
    organization: String(body.organization ?? 'Unknown'),
    type: typeof body.type === 'string' ? body.type : null,
    subtype: typeof body.subtype === 'string' ? body.subtype : null,
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
    body: typeof body.body === 'string' ? body.body : '',
    version: 1,
    authoredBy: 'agent',
    linkedContacts: link,
    evidence: Array.isArray(body.evidence) ? body.evidence : [],
    history: [
      {
        id: 'H1',
        version: 1,
        at: now,
        actor: { kind: 'agent', agentName: 'digital-twin-builder' },
        kind: 'created',
        changedFields: [],
        changeSummary: typeof body.changeSummary === 'string' ? body.changeSummary : 'Created',
        sourceDocumentId: body.sourceDocumentId ?? null,
        sourceRunId: null,
        evidence: [],
      },
    ],
    updatedAt: now,
  };
  await upsertPersonaRow(admin, persona);
  return persona;
}

export async function updatePersona(
  admin: SupabaseClient,
  tenantId: string,
  conductiaTenantId: string,
  personaId: string,
  ifVersion: number,
  patch: Record<string, unknown>,
  extras: { evidence?: unknown[]; noChangeRationale?: string | null; changeSummary?: string | null },
): Promise<StoredPersona> {
  const current = await getPersona(admin, tenantId, conductiaTenantId, personaId);
  if (!current) throw new Error('Persona not found');
  if (current.version !== ifVersion) throw versionConflict(ifVersion, current.version);

  const next: StoredPersona = {
    ...current,
    name: typeof patch.name === 'string' ? patch.name : current.name,
    title: typeof patch.title === 'string' ? patch.title : current.title,
    organization: typeof patch.organization === 'string' ? patch.organization : current.organization,
    type: patch.type === undefined ? current.type : (patch.type as string | null),
    subtype: patch.subtype === undefined ? current.subtype : (patch.subtype as string | null),
    tags: Array.isArray(patch.tags) ? patch.tags.map(String) : current.tags,
    body: typeof patch.body === 'string' ? patch.body : current.body,
    evidence: [...current.evidence, ...(extras.evidence ?? [])],
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
  next.history = [
    ...current.history,
    {
      id: `H${current.history.length + 1}`,
      version: next.version,
      at: next.updatedAt,
      actor: { kind: 'agent', agentName: 'digital-twin-builder' },
      kind: extras.noChangeRationale ? 'reviewed_no_change' : 'updated',
      changedFields: [],
      changeSummary: extras.noChangeRationale ?? extras.changeSummary ?? 'Updated',
      sourceDocumentId: null,
      sourceRunId: null,
      evidence: extras.evidence ?? [],
    },
  ];
  await writePersonaIfVersion(admin, next, ifVersion);
  return next;
}

/**
 * Link a roster contact to a persona.
 *
 * `link.tenantId` is NOT taken from the caller. listPersonas filters on
 * `link.leadId`, so an attacker-chosen link is a write INTO the read filter: it
 * would surface a persona under another tenant's lead listing. The tenant is
 * stamped from the verified scope, and the route validates the leadId.
 *
 * A link changes who may write the persona, so it is a versioned write like an
 * update: it lands only on `ifVersion` (the version the caller authorized) and
 * advances it, so a write authorized against the pre-link persona misses.
 */
export async function linkPersona(
  admin: SupabaseClient,
  tenantId: string,
  conductiaTenantId: string,
  personaId: string,
  ifVersion: number,
  link: { leadId: string; contactId: string },
): Promise<StoredPersona | null> {
  const current = await getPersona(admin, tenantId, conductiaTenantId, personaId);
  if (!current) return null;
  if (current.version !== ifVersion) throw versionConflict(ifVersion, current.version);
  const stamped = { tenantId, leadId: link.leadId, contactId: link.contactId };
  const exists = current.linkedContacts.some(
    (item) =>
      item.tenantId === stamped.tenantId &&
      item.leadId === stamped.leadId &&
      item.contactId === stamped.contactId,
  );
  if (exists) return current;
  const next: StoredPersona = {
    ...current,
    linkedContacts: [...current.linkedContacts, stamped],
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
  next.history = [
    ...current.history,
    {
      id: `H${current.history.length + 1}`,
      version: next.version,
      at: next.updatedAt,
      actor: { kind: 'agent', agentName: 'digital-twin-builder' },
      kind: 'linked',
      changedFields: [],
      changeSummary: 'Linked a roster contact',
      sourceDocumentId: null,
      sourceRunId: null,
      evidence: [],
    },
  ];
  await writePersonaIfVersion(admin, next, ifVersion);
  return next;
}

export function personaSummary(persona: StoredPersona) {
  return {
    personaId: persona.personaId,
    tenantId: persona.tenantId,
    name: persona.name,
    title: persona.title,
    organization: persona.organization,
    type: persona.type,
    subtype: persona.subtype,
    tags: persona.tags,
  };
}

export function personaRead(persona: StoredPersona) {
  return {
    ...personaSummary(persona),
    version: persona.version,
    authoredBy: persona.authoredBy,
    body: persona.body,
    linkedContacts: persona.linkedContacts,
    evidence: persona.evidence,
    history: persona.history,
  };
}

export function personaReceipt(
  persona: StoredPersona,
  outcome: 'created' | 'updated' | 'linked' | 'unchanged',
) {
  return {
    personaId: persona.personaId,
    outcome,
    appliedPaths: outcome === 'created' ? ['persona.name', 'persona.body'] : [],
    clearedPaths: [],
    deferredPaths: [],
    flaggedPaths: [],
    evidenceAdded: 0,
    newVersion: persona.version,
    writtenAt: persona.updatedAt,
  };
}

function versionConflict(expected: number, current: number | 'changed'): Error {
  const error = new Error(`expected ${expected}, current ${current}`);
  error.name = 'VersionConflict';
  return error;
}

/**
 * Compare-and-set: write `persona` only if the stored row is still at
 * `expectedVersion`. A concurrent update or link advanced it, so this write
 * was authorized against a persona that no longer exists: VersionConflict.
 */
async function writePersonaIfVersion(
  admin: SupabaseClient,
  persona: StoredPersona,
  expectedVersion: number,
): Promise<void> {
  const { data, error } = await admin
    .from(TABLE.LEAD_PERSONAS)
    .update(personaRow(persona))
    .eq('id', persona.personaId)
    .eq('tenant_id', persona.tenantId)
    .eq('conductia_tenant_id', persona.conductiaTenantId)
    .eq('version', expectedVersion)
    .select('id');
  if (error) throw dbFailure('Persona update', error);
  if (!data || data.length === 0) throw versionConflict(expectedVersion, 'changed');
}

async function upsertPersonaRow(admin: SupabaseClient, persona: StoredPersona): Promise<void> {
  const { error } = await admin.from(TABLE.LEAD_PERSONAS).upsert(personaRow(persona));
  if (error) throw dbFailure('Persona save', error);
}

function personaRow(persona: StoredPersona) {
  return {
    id: persona.personaId,
    tenant_id: persona.tenantId,
    conductia_tenant_id: persona.conductiaTenantId,
    name: persona.name,
    title: persona.title,
    organization: persona.organization,
    type: persona.type,
    subtype: persona.subtype,
    tags: persona.tags,
    body: persona.body,
    version: persona.version,
    authored_by: persona.authoredBy,
    links: persona.linkedContacts,
    evidence: persona.evidence,
    history: persona.history,
    updated_at: persona.updatedAt,
  };
}

function isLink(value: unknown): value is { leadId: string; contactId: string } {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.leadId === 'string' &&
    typeof rec.contactId === 'string'
  );
}

function rowToPersona(row: Record<string, unknown>): StoredPersona {
  return {
    personaId: String(row.id),
    tenantId: String(row.tenant_id),
    conductiaTenantId: (row.conductia_tenant_id as string | null) ?? null,
    name: String(row.name),
    title: String(row.title),
    organization: String(row.organization),
    type: (row.type as string | null) ?? null,
    subtype: (row.subtype as string | null) ?? null,
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    body: String(row.body ?? ''),
    version: Number(row.version ?? 1),
    authoredBy: row.authored_by === 'human' ? 'human' : 'agent',
    linkedContacts: Array.isArray(row.links)
      ? (row.links as StoredPersona['linkedContacts'])
      : [],
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    history: Array.isArray(row.history) ? row.history : [],
    updatedAt: String(row.updated_at ?? row.created_at ?? new Date().toISOString()),
  };
}
