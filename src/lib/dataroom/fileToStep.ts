import type { SupabaseClient } from '@supabase/supabase-js';

import { getBoxClient } from '@/lib/box';
import { boxSafeFileName } from '@/lib/box/safeName';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { DOCUMENT_CLASSIFICATION, DOCUMENT_ROOM } from '@/lib/constants/documents';
import { DOCUMENT_STORAGE_PROVIDER } from '@/lib/constants/datarooms';
import { TABLE } from '@/lib/constants/tables';
import { dbFailure } from '@/lib/errors/upstream';
import { isUuid } from '@/lib/skillPublication/parse';

import { provisionDataroomFolder, seedDataroomsForDeal } from './steps';

export function safeFileName(name: string, fallback = 'brief.docx'): string {
  const trimmed = name.trim().replace(/[/\\]/g, '-');
  return trimmed || fallback;
}

export async function fileBytesToStepDataroom(opts: {
  admin: SupabaseClient;
  dealId: string;
  dealCode: string;
  stepId: string;
  stepTitle?: string;
  fileName: string;
  bytes: Buffer;
  uploadedBy: string;
  stepSkillRunId?: string | null;
  auditDetail?: Record<string, unknown>;
}): Promise<{ documentId: string; boxFileId: string }> {
  await seedDataroomsForDeal(opts.admin, opts.dealId);
  const dataroom = await provisionDataroomFolder(
    opts.admin,
    opts.dealId,
    opts.stepId,
    opts.dealCode,
    opts.stepTitle,
  );
  if (!dataroom.box_folder_id) {
    throw new Error('Dataroom folder not provisioned');
  }

  const fileName = safeFileName(opts.fileName);
  // Box gets a safe, unique name (#328): two files whose names sanitize
  // alike must not land on one Box file. documents.name keeps fileName.
  const uploaded = await getBoxClient().uploadFile(
    dataroom.box_folder_id,
    boxSafeFileName(`${crypto.randomUUID().slice(0, 8)}-${fileName}`),
    opts.bytes,
  );

  const { data: document, error: docError } = await opts.admin
    .from(TABLE.DOCUMENTS)
    .insert({
      deal_id: opts.dealId,
      name: fileName,
      room: DOCUMENT_ROOM.INTERNAL,
      classification: DOCUMENT_CLASSIFICATION.CONFIDENTIAL,
      min_phase: dataroom.min_phase,
      uploaded_by: opts.uploadedBy,
      dataroom_id: dataroom.id,
      box_file_id: uploaded.id,
      storage_provider: DOCUMENT_STORAGE_PROVIDER.BOX,
      step_skill_run_id: isUuid(opts.stepSkillRunId) ? opts.stepSkillRunId : null,
    })
    .select('id')
    .single();
  if (docError || !document) {
    throw docError ? dbFailure('Document record', docError) : new Error('Failed to record document');
  }

  const { error: auditError } = await opts.admin.from(TABLE.AUDIT_LOG).insert({
    actor_id: opts.uploadedBy,
    action: AUDIT_ACTION.UPLOAD,
    deal_id: opts.dealId,
    document_id: document.id,
    detail: {
      stepId: opts.stepId,
      name: fileName,
      fileName,
      boxFileId: uploaded.id,
      size: opts.bytes.length,
      ...opts.auditDetail,
    },
  });
  if (auditError) {
    await opts.admin.from(TABLE.DOCUMENTS).delete().eq('id', document.id);
    throw new Error('Upload could not be audited');
  }

  return { documentId: document.id, boxFileId: uploaded.id };
}
