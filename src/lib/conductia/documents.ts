import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';

import { resolveLeadCompany } from './resolve';
import { dbFailure } from '@/lib/errors/upstream';

const FOLDERS = new Set(['source-materials', 'md-brief', 'working-papers']);
const DOCUMENT_TYPES = new Set([
  'source_transcript',
  'lead_partner_debrief',
  'md_brief',
  'company_background',
  'other',
]);
const EXTRACTION_TYPES = new Set(['source_transcript', 'lead_partner_debrief']);

export type StoredDocument = {
  documentId: string;
  tenantId: string;
  leadId: string;
  companyId: string | null;
  title: string;
  documentType: string;
  folder: string;
  kind: string;
  text: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  version: number;
  uploadedAt: string;
};

export function canonicalizeText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

export function contentHashOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export async function persistLeadDocument(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    leadId: string;
    title: string;
    documentType: string;
    folder: string;
    kind?: string;
    text?: string | null;
    originalFilename?: string | null;
    mimeType?: string | null;
    documentId?: string;
  },
): Promise<StoredDocument> {
  const folder = FOLDERS.has(input.folder) ? input.folder : 'source-materials';
  const documentType = DOCUMENT_TYPES.has(input.documentType) ? input.documentType : 'other';
  const title = input.title.trim() || 'Untitled';
  const text = input.text?.trim() ? canonicalizeText(input.text) : null;
  const company = await resolveLeadCompany(admin, input.leadId);

  const { data: prior } = await admin
    .from(TABLE.LEAD_DOCUMENTS)
    .select('id, version')
    .eq('lead_id', input.leadId)
    .eq('title', title)
    .eq('document_type', documentType)
    .maybeSingle();

  const documentId = input.documentId ?? prior?.id ?? `doc_${crypto.randomUUID()}`;
  const version = ((prior?.version as number | undefined) ?? 0) + 1;
  const uploadedAt = new Date().toISOString();

  const { error } = await admin.from(TABLE.LEAD_DOCUMENTS).upsert({
    id: documentId,
    tenant_id: input.tenantId,
    lead_id: input.leadId,
    company_id: company?.id ?? null,
    title,
    document_type: documentType,
    folder,
    kind: input.kind ?? (EXTRACTION_TYPES.has(documentType) ? 'meeting_notes' : 'memo'),
    text_content: text,
    original_filename: input.originalFilename ?? null,
    mime_type: input.mimeType ?? null,
    version,
    created_at: uploadedAt,
  });
  if (error) throw dbFailure('Lead document save', error);

  return {
    documentId,
    tenantId: input.tenantId,
    leadId: input.leadId,
    companyId: company?.id ?? null,
    title,
    documentType,
    folder,
    kind: input.kind ?? (EXTRACTION_TYPES.has(documentType) ? 'meeting_notes' : 'memo'),
    text,
    originalFilename: input.originalFilename ?? null,
    mimeType: input.mimeType ?? null,
    version,
    uploadedAt,
  };
}

export const LEAD_DOCUMENT_PAGE_MAX = 200;

export type StoredDocumentSummary = Omit<StoredDocument, 'text'> & {
  contentHash: string | null;
  charLength: number | null;
};

export type LeadDocumentPage = {
  documents: StoredDocumentSummary[];
  nextOffset: number | null;
};

const DOCUMENT_COLUMNS =
  'id, tenant_id, lead_id, company_id, title, document_type, folder, kind, original_filename, mime_type, version, created_at';

export async function listLeadDocuments(
  admin: SupabaseClient,
  leadId: string,
  page: { limit: number; offset: number } = { limit: LEAD_DOCUMENT_PAGE_MAX, offset: 0 },
): Promise<LeadDocumentPage> {
  const { data, error } = await admin
    .from(TABLE.LEAD_DOCUMENTS)
    .select(`${DOCUMENT_COLUMNS}, content_hash, text_length`)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(page.offset, page.offset + page.limit);
  if (error) throw dbFailure('Lead documents list', error);
  const rows = data ?? [];
  return {
    documents: rows.slice(0, page.limit).map(rowToSummary),
    nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
  };
}

export async function getLeadDocument(
  admin: SupabaseClient,
  leadId: string,
  documentId: string,
): Promise<StoredDocument | null> {
  const { data, error } = await admin
    .from(TABLE.LEAD_DOCUMENTS)
    .select(`${DOCUMENT_COLUMNS}, text_content`)
    .eq('id', documentId)
    .eq('lead_id', leadId)
    .maybeSingle();
  if (error) throw dbFailure('Lead document read', error);
  return data ? rowToDocument(data) : null;
}

export function documentSummary(doc: StoredDocumentSummary, agentName: string, runId: string) {
  return {
    documentId: doc.documentId,
    leadId: doc.leadId,
    kind: doc.kind,
    documentType: doc.documentType,
    folder: doc.folder,
    version: doc.version,
    title: doc.title,
    contentHash: doc.contentHash,
    charLength: doc.charLength,
    occurredAt: null,
    uploadedAt: doc.uploadedAt,
    uploadedBy: { kind: 'agent' as const, agentName, runId },
  };
}

export function documentRead(doc: StoredDocument, agentName: string, runId: string) {
  const text = doc.text;
  return {
    documentId: doc.documentId,
    tenantId: doc.tenantId,
    leadId: doc.leadId,
    kind: doc.kind,
    documentType: doc.documentType,
    folder: doc.folder,
    version: doc.version,
    title: doc.title,
    text,
    charLength: text?.length ?? null,
    contentHash: text ? contentHashOf(text) : null,
    normalization: text
      ? {
          canonicalizationVersion: 'canon-1',
          unicodeForm: 'NFC',
          lineEndings: 'LF',
          controlCharsStripped: true,
          extractedBy: 'intellibank-1',
          extractedAt: doc.uploadedAt,
        }
      : null,
    occurredAt: null,
    uploadedAt: doc.uploadedAt,
    uploadedBy: { kind: 'agent' as const, agentName, runId },
    participants: [],
    language: null,
    mimeType: doc.mimeType,
    originalFilename: doc.originalFilename,
    original: null,
  };
}

function rowToFields(row: Record<string, unknown>): Omit<StoredDocument, 'text'> {
  return {
    documentId: String(row.id),
    tenantId: String(row.tenant_id),
    leadId: String(row.lead_id),
    companyId: (row.company_id as string | null) ?? null,
    title: String(row.title),
    documentType: String(row.document_type),
    folder: String(row.folder),
    kind: String(row.kind ?? 'other'),
    originalFilename: (row.original_filename as string | null) ?? null,
    mimeType: (row.mime_type as string | null) ?? null,
    version: Number(row.version ?? 1),
    uploadedAt: String(row.created_at),
  };
}

function rowToDocument(row: Record<string, unknown>): StoredDocument {
  return { ...rowToFields(row), text: (row.text_content as string | null) ?? null };
}

function rowToSummary(row: Record<string, unknown>): StoredDocumentSummary {
  return {
    ...rowToFields(row),
    contentHash: (row.content_hash as string | null) ?? null,
    charLength: row.text_length == null ? null : Number(row.text_length),
  };
}
