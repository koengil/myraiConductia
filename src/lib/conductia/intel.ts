import type { SupabaseClient } from '@supabase/supabase-js';

import { upsertCrmPerson } from '@/lib/api/v1/crmPeople';
import {
  DECISION_ROLES,
  RELATIONSHIP_TYPES,
  STANCES,
  STRENGTH_LEVELS,
} from '@/lib/constants/leadMaps';
import { TABLE } from '@/lib/constants/tables';

import { emptyRecord } from './lead';
import { resolveLeadCompany } from './resolve';
import { dbFailure } from '@/lib/errors/upstream';

export type IntelState = {
  leadId: string;
  tenantId: string;
  companyId: string | null;
  version: number;
  relationshipVersion: number;
  stakeholderVersion: number;
  fields: Record<string, unknown>;
  relationshipMap: { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
  stakeholderMap: { stakeholders: Record<string, unknown>[] };
  tasks: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  updatedAt: string | null;
};

type Keyed = Record<string, unknown> & { key?: string };

export class VersionConflict extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`expected ${expected}, current ${actual}`);
    this.name = 'VersionConflict';
    this.expected = expected;
    this.actual = actual;
  }
}

export async function loadIntel(
  admin: SupabaseClient,
  leadId: string,
  tenantId: string,
): Promise<IntelState> {
  const { data } = await admin.from(TABLE.LEAD_INTEL).select('*').eq('lead_id', leadId).maybeSingle();
  if (data) return rowToIntel(data as Record<string, unknown>);

  const company = await resolveLeadCompany(admin, leadId);
  return {
    leadId,
    tenantId,
    companyId: company?.id ?? null,
    version: 0,
    relationshipVersion: 0,
    stakeholderVersion: 0,
    fields: emptyRecord() as unknown as Record<string, unknown>,
    relationshipMap: { nodes: [], edges: [] },
    stakeholderMap: { stakeholders: [] },
    tasks: [],
    notes: [],
    updatedAt: null,
  };
}

export async function seedStakeholderMapFromCrm(
  admin: SupabaseClient,
  intel: IntelState,
): Promise<IntelState> {
  if (intel.stakeholderMap.stakeholders.length > 0 || !intel.companyId) return intel;
  const { data } = await admin
    .from('lead_stakeholders')
    .select('id, name, title, org')
    .eq('company_id', intel.companyId);
  const stakeholders = (data ?? [])
    .filter((row) => typeof row.name === 'string' && row.name.trim())
    .map((row) => ({
      key: `p:${slug(String(row.name))}`,
      contact: { id: row.id as string },
      decisionRole: 'unknown',
      stance: 'unknown',
      influence: 'unknown',
      sensitivities: [],
      priorities: [],
      text: null,
      claims: [],
      aliases: [],
    }));
  return { ...intel, stakeholderMap: { stakeholders } };
}

export async function seedRelationshipMapFromCrm(
  admin: SupabaseClient,
  intel: IntelState,
): Promise<IntelState> {
  if (intel.relationshipMap.nodes.length > 0 || !intel.companyId) return intel;
  const { data } = await admin
    .from('lead_relationships')
    .select('id, person_name, title, person_company, relationship_type, strength')
    .eq('company_id', intel.companyId);
  const nodes = (data ?? [])
    .filter((row) => typeof row.person_name === 'string' && row.person_name.trim())
    .map((row) => ({
      key: `r:${slug(String(row.person_name))}`,
      contact: {
        id: row.id as string,
        name: row.person_name,
        title: typeof row.title === 'string' ? row.title : null,
        org: typeof row.person_company === 'string' ? row.person_company : null,
      },
      kind: row.relationship_type,
      strength: row.strength,
    }));
  return { ...intel, relationshipMap: { nodes, edges: intel.relationshipMap.edges } };
}

export async function applyLeadFieldsPatch(
  admin: SupabaseClient,
  leadId: string,
  tenantId: string,
  ifVersion: number,
  patch: Record<string, unknown>,
): Promise<{ state: IntelState; appliedPaths: string[] }> {
  const current = await loadIntel(admin, leadId, tenantId);
  if (current.version !== ifVersion) throw new VersionConflict(ifVersion, current.version);
  const nextFields = mergeLeadFields(current.fields, patch);
  const next = await saveIntel(admin, {
    ...current,
    tenantId,
    fields: nextFields,
    version: current.version + 1,
  });
  return { state: next, appliedPaths: Object.keys(patch).filter((key) => key !== 'clears') };
}

export async function applyRelationshipPatch(
  admin: SupabaseClient,
  leadId: string,
  tenantId: string,
  ifVersion: number,
  patch: Record<string, unknown>,
): Promise<{ state: IntelState; appliedPaths: string[] }> {
  const current = await loadIntel(admin, leadId, tenantId);
  if (current.relationshipVersion !== ifVersion) {
    throw new VersionConflict(ifVersion, current.relationshipVersion);
  }
  const nextMap = {
    nodes: applyKeyed(current.relationshipMap.nodes, asCollection(patch.nodes)),
    edges: applyKeyed(current.relationshipMap.edges, asCollection(patch.edges)),
  };
  const next = await saveIntel(admin, {
    ...current,
    tenantId,
    relationshipMap: nextMap,
    relationshipVersion: current.relationshipVersion + 1,
  });
  await syncRelationshipsToCrm(admin, next);
  return { state: next, appliedPaths: ['relationshipMap.nodes', 'relationshipMap.edges'] };
}

export async function applyStakeholderPatch(
  admin: SupabaseClient,
  leadId: string,
  tenantId: string,
  ifVersion: number,
  patch: Record<string, unknown>,
): Promise<{ state: IntelState; appliedPaths: string[] }> {
  let current = await loadIntel(admin, leadId, tenantId);
  current = await seedStakeholderMapFromCrm(admin, current);
  if (current.stakeholderVersion !== ifVersion) {
    throw new VersionConflict(ifVersion, current.stakeholderVersion);
  }
  const nextMap = {
    stakeholders: applyKeyed(current.stakeholderMap.stakeholders, asCollection(patch.stakeholders)),
  };
  const next = await saveIntel(admin, {
    ...current,
    tenantId,
    stakeholderMap: nextMap,
    stakeholderVersion: current.stakeholderVersion + 1,
  });
  await syncStakeholdersToCrm(admin, next);
  return { state: next, appliedPaths: ['stakeholderMap.stakeholders'] };
}

export async function addTask(
  admin: SupabaseClient,
  leadId: string,
  tenantId: string,
  task: Record<string, unknown>,
): Promise<{ taskId: string; dedupeKey: string; outcome: 'created' | 'updated'; writtenAt: string }> {
  const current = await loadIntel(admin, leadId, tenantId);
  const dedupeKey =
    typeof task.dedupeKey === 'string' && task.dedupeKey.trim()
      ? task.dedupeKey.trim()
      : `task:${crypto.randomUUID()}`;
  const existing = current.tasks.find((row) => row.dedupeKey === dedupeKey);
  const writtenAt = new Date().toISOString();
  const taskId = existing?.taskId ? String(existing.taskId) : `task_${crypto.randomUUID()}`;
  const stored = {
    taskId,
    leadId,
    dedupeKey,
    intent: task.intent ?? 'other',
    title: task.title ?? 'Follow up',
    status: existing?.status ?? 'open',
    details: task.details ?? null,
    talkingPoints: task.talkingPoints ?? [],
    claims: task.claims ?? [],
    createdAt: existing?.createdAt ?? writtenAt,
    updatedAt: writtenAt,
    proposedByRunId: task.proposedByRunId ?? null,
    agentName: task.agentName ?? null,
  };
  const tasks = existing
    ? current.tasks.map((row) => (row.dedupeKey === dedupeKey ? stored : row))
    : [...current.tasks, stored];
  await saveIntel(admin, { ...current, tenantId, tasks });
  return { taskId, dedupeKey, outcome: existing ? 'updated' : 'created', writtenAt };
}

export async function addNote(
  admin: SupabaseClient,
  leadId: string,
  tenantId: string,
  note: { title: string; body: string; topic?: unknown },
): Promise<{ noteId: string; writtenAt: string }> {
  const current = await loadIntel(admin, leadId, tenantId);
  const writtenAt = new Date().toISOString();
  const noteId = `note_${crypto.randomUUID()}`;
  await saveIntel(admin, {
    ...current,
    tenantId,
    notes: [...current.notes, { noteId, ...note, writtenAt }],
  });
  return { noteId, writtenAt };
}

export function writeReceipt(
  target: 'lead' | 'relationship_map' | 'stakeholder_map' | 'task' | 'deal_note',
  newVersion: number | null,
  _appliedPaths: string[] = [],
) {
  return {
    target,
    appliedPaths: [] as string[],
    clearedPaths: [],
    deferredPaths: [],
    flaggedPaths: [],
    newVersion,
    attempts: 1,
    idempotent: false,
    writtenAt: new Date().toISOString(),
  };
}

async function saveIntel(admin: SupabaseClient, state: IntelState): Promise<IntelState> {
  const company = state.companyId
    ? { id: state.companyId }
    : await resolveLeadCompany(admin, state.leadId);
  const updatedAt = new Date().toISOString();
  const { error } = await admin.from(TABLE.LEAD_INTEL).upsert({
    lead_id: state.leadId,
    tenant_id: state.tenantId,
    company_id: company?.id ?? state.companyId,
    version: state.version,
    relationship_version: state.relationshipVersion,
    stakeholder_version: state.stakeholderVersion,
    fields: state.fields,
    relationship_map: state.relationshipMap,
    stakeholder_map: state.stakeholderMap,
    tasks: state.tasks,
    notes: state.notes,
    updated_at: updatedAt,
  });
  if (error) throw dbFailure('Lead intel save', error);
  return { ...state, companyId: company?.id ?? state.companyId, updatedAt };
}

function mergeLeadFields(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(current);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'clears' || value === undefined) continue;
    if (value && typeof value === 'object' && 'upsert' in (value as object)) {
      const existing = Array.isArray(next[key]) ? (next[key] as Keyed[]) : [];
      next[key] = applyKeyed(existing, asCollection(value));
      continue;
    }
    next[key] = value;
  }
  return next;
}

function asCollection(value: unknown): { upsert: Keyed[]; remove: { key: string }[] } {
  if (!value || typeof value !== 'object') return { upsert: [], remove: [] };
  const rec = value as { upsert?: unknown; remove?: unknown };
  return {
    upsert: Array.isArray(rec.upsert) ? (rec.upsert as Keyed[]) : [],
    remove: Array.isArray(rec.remove) ? (rec.remove as { key: string }[]) : [],
  };
}

export function applyKeyed(
  existing: Keyed[],
  patch: { upsert: Keyed[]; remove: { key: string }[] },
): Keyed[] {
  const byKey = new Map<string, Keyed>();
  for (const item of existing) {
    if (typeof item.key === 'string') byKey.set(item.key, { ...item });
  }
  for (const removed of patch.remove) {
    if (removed?.key) byKey.delete(removed.key);
  }
  for (const item of patch.upsert) {
    if (typeof item.key !== 'string') continue;
    const prior = byKey.get(item.key) ?? {};
    const merged: Keyed = { ...prior, ...item };
    for (const nested of ['sensitivities', 'priorities'] as const) {
      const patchNested = item[nested];
      if (patchNested && typeof patchNested === 'object' && 'upsert' in (patchNested as object)) {
        const priorNested = Array.isArray(prior[nested]) ? (prior[nested] as Keyed[]) : [];
        merged[nested] = applyKeyed(priorNested, asCollection(patchNested));
      }
    }
    byKey.set(item.key, merged);
  }
  return [...byKey.values()];
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function syncStakeholdersToCrm(admin: SupabaseClient, intel: IntelState): Promise<void> {
  if (!intel.companyId) return;
  const company = await resolveLeadCompany(admin, intel.companyId);
  if (!company) return;

  const { data: current } = await admin
    .from('lead_stakeholders')
    .select('id, name')
    .eq('company_id', company.id);
  const known = new Map(
    (current ?? []).map((row) => [String(row.name ?? '').trim().toLowerCase(), row.id as string]),
  );

  for (const row of intel.stakeholderMap.stakeholders) {
    const contact = row.contact as { id?: string; name?: string; title?: string; org?: string } | undefined;
    const name =
      (typeof contact?.name === 'string' && contact.name.trim()) ||
      (typeof contact?.id === 'string'
        ? ((current ?? []).find((item) => item.id === contact.id)?.name as string | undefined)
        : undefined);
    if (!name?.trim()) continue;
    const key = name.trim().toLowerCase();
    if (known.has(key)) continue;

    const personId = await upsertCrmPerson(admin, {
      tenantId: company.tenantId,
      registeredByCompanyId: company.registeredByCompanyId,
      name: name.trim(),
      title: typeof contact?.title === 'string' ? contact.title : null,
      org: typeof contact?.org === 'string' ? contact.org : null,
    });
    const { data: inserted } = await admin
      .from('lead_stakeholders')
      .insert({
        tenant_id: company.tenantId,
        company_id: company.id,
        person_id: personId,
        name: name.trim(),
        title: typeof contact?.title === 'string' ? contact.title : null,
        org: typeof contact?.org === 'string' ? contact.org : null,
        role_in_decision: mapDecisionRole(row.decisionRole),
        motivation: 'max price',
        stance: mapStance(row.stance),
        board_seat: false,
        investor: false,
        likely_objections: 'Added from source intelligence',
      })
      .select('id')
      .maybeSingle();
    if (inserted?.id) known.set(key, inserted.id as string);
  }
}

async function syncRelationshipsToCrm(admin: SupabaseClient, intel: IntelState): Promise<void> {
  if (!intel.companyId) return;
  const company = await resolveLeadCompany(admin, intel.companyId);
  if (!company) return;

  const { data: current } = await admin
    .from('lead_relationships')
    .select('person_name')
    .eq('company_id', company.id);
  const known = new Set(
    (current ?? []).map((row) => String(row.person_name ?? '').trim().toLowerCase()).filter(Boolean),
  );

  for (const node of intel.relationshipMap.nodes) {
    const contact = node.contact as { name?: string; title?: string; org?: string } | null | undefined;
    const name = typeof contact?.name === 'string' ? contact.name.trim() : '';
    if (!name || known.has(name.toLowerCase())) continue;
    const personId = await upsertCrmPerson(admin, {
      tenantId: company.tenantId,
      registeredByCompanyId: company.registeredByCompanyId,
      name,
      title: typeof contact?.title === 'string' ? contact.title : null,
      org: typeof contact?.org === 'string' ? contact.org : null,
    });
    await admin.from('lead_relationships').insert({
      tenant_id: company.tenantId,
      company_id: company.id,
      person_id: personId,
      person_name: name,
      title: typeof contact?.title === 'string' ? contact.title : null,
      person_company: typeof contact?.org === 'string' ? contact.org : null,
      relationship_type: mapRelationshipType(node.kind),
      strength: STRENGTH_LEVELS[1],
      source: 'banker asserted',
      confidence: STRENGTH_LEVELS[1],
      basis: 'Added from source intelligence',
    });
    known.add(name.toLowerCase());
  }
}

function mapDecisionRole(value: unknown): string {
  const raw = String(value ?? '');
  if (raw === 'decision_maker' || raw === 'approver') return DECISION_ROLES[0];
  if (raw === 'gatekeeper') return 'gatekeeper';
  if (raw === 'blocker') return 'blocker';
  return 'influencer';
}

function mapStance(value: unknown): string {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'supporter') return STANCES[0];
  if (raw === 'detractor') return STANCES[2] ?? STANCES[1];
  return STANCES[1] ?? STANCES[0];
}

function mapRelationshipType(value: unknown): string {
  const raw = String(value ?? '');
  if (raw === 'board_member') return 'board member';
  if (raw === 'investor') return 'co-investor';
  if (raw === 'personal_friend') return 'personal';
  if (raw === 'client_of') return 'prior client';
  if (raw === 'counterparty_of') return 'prior deal counterparty';
  if (RELATIONSHIP_TYPES.includes(raw as (typeof RELATIONSHIP_TYPES)[number])) return raw;
  return 'colleague';
}

function rowToIntel(row: Record<string, unknown>): IntelState {
  const fields = (row.fields as Record<string, unknown> | null) ?? {};
  return {
    leadId: String(row.lead_id),
    tenantId: String(row.tenant_id),
    companyId: (row.company_id as string | null) ?? null,
    version: Number(row.version ?? 0),
    relationshipVersion: Number(row.relationship_version ?? 0),
    stakeholderVersion: Number(row.stakeholder_version ?? 0),
    fields: Object.keys(fields).length ? fields : (emptyRecord() as unknown as Record<string, unknown>),
    relationshipMap: (row.relationship_map as IntelState['relationshipMap']) ?? {
      nodes: [],
      edges: [],
    },
    stakeholderMap: (row.stakeholder_map as IntelState['stakeholderMap']) ?? { stakeholders: [] },
    tasks: Array.isArray(row.tasks) ? (row.tasks as Record<string, unknown>[]) : [],
    notes: Array.isArray(row.notes) ? (row.notes as Record<string, unknown>[]) : [],
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}
