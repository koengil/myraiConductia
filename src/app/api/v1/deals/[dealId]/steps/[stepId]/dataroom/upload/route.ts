import { NextResponse } from 'next/server';

import { classifyInternalUser, userCanAccessDeal, userCanUploadToDataroom } from '@/lib/api/v1/access';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { getBoxClient } from '@/lib/box';
import { scheduleDocumentContentTags } from '@/lib/compliance/documentTags';
import { boxSafeFileName } from '@/lib/box/safeName';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { DOCUMENT_CLASSIFICATION } from '@/lib/constants/documents';
import { DOCUMENT_STORAGE_PROVIDER } from '@/lib/constants/datarooms';
import { DOCUMENT_ROOM } from '@/lib/constants/documents';
import { errorCodeOf } from '@/lib/errors/upstream';
import { TABLE } from '@/lib/constants/tables';
import { loadDealByIdOrCode, provisionDataroomFolder } from '@/lib/dataroom/steps';
import {
  DEFAULT_DEAL_FOLDER,
  parseDealFolder,
  parseDealFolderSubpath,
} from '@/lib/dataroom/taxonomy';
import { orderedSteps } from '@/lib/rail/dealRail';

type RouteContext = { params: Promise<{ dealId: string; stepId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId, stepId } = await context.params;

  let deal;
  try {
    deal = await loadDealByIdOrCode(auth.admin, dealId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to resolve deal';
    return jsonError(message, 500);
  }
  if (!deal) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return dealNotVisible();


  // Internal-only surface: rail-step datarooms are bank work product.
  // Fail closed — a lookup error is a server fault, not access.
  const wall = await classifyInternalUser(auth.admin, auth.user.id);
  if (wall === 'error') return jsonError('Profile lookup failed', 500);
  if (wall !== 'internal') return jsonError('Forbidden', 403);

  if (!orderedSteps().some((s) => s.id === stepId)) {
    return jsonError('Unknown rail step id', 400);
  }


  const canUpload = await userCanUploadToDataroom(auth.admin, auth.user.id, deal.id);
  if (!canUpload) return jsonError('Upload not permitted for this role', 403);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError('Expected multipart form data', 400);
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return jsonError('A non-empty file field is required', 400);
  }

  const classificationRaw = formData.get('classification');
  const classification =
    typeof classificationRaw === 'string'
      ? Number.parseInt(classificationRaw, 10)
      : DOCUMENT_CLASSIFICATION.CONFIDENTIAL;
  if (
    !Number.isInteger(classification) ||
    classification < 1 ||
    classification > 4
  ) {
    return jsonError('classification must be an integer between 1 and 4', 400);
  }

  const folderRaw = formData.get('folder');
  const folder =
    folderRaw == null || String(folderRaw).trim() === ''
      ? DEFAULT_DEAL_FOLDER
      : parseDealFolder(folderRaw);
  if (!folder) {
    return jsonError('folder must be one of the eight Deal Folder destinations', 400);
  }
  const subpath = parseDealFolderSubpath(formData.get('folderSubpath'));
  if (!subpath) {
    return jsonError('folderSubpath must be at most 3 path segments', 400);
  }

  try {
    const dataroom = await provisionDataroomFolder(
      auth.admin,
      deal.id,
      stepId,
      deal.code,
    );
    if (!dataroom.box_folder_id) {
      return jsonError('Dataroom folder not provisioned', 503);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const box = getBoxClient();
    // Box gets a safe, unique name (#328): two files whose names sanitize
    // alike must not land on one Box file. documents.name keeps file.name.
    const uploaded = await box.uploadFile(
      dataroom.box_folder_id,
      boxSafeFileName(`${crypto.randomUUID().slice(0, 8)}-${file.name}`),
      buffer,
    );
    // The Box upload is not transactional with the rows below. If either row
    // fails, remove the file so no bank document sits in Box with no record
    // or audit trail (#249). A failed delete is logged for manual cleanup.
    const discardUpload = (documentId?: string) =>
      box.deleteFile(uploaded.id).catch((err) => {
        console.error('[dataroom] orphaned Box file', {
          documentId,
          boxFileId: uploaded.id,
          code: errorCodeOf(err),
        });
      });

    const { data: document, error: docError } = await auth.admin
      .from(TABLE.DOCUMENTS)
      .insert({
        deal_id: deal.id,
        name: file.name,
        // Rail-step folders are bank work product: file them in the
        // internal room so the #124 document wall keeps them from
        // external users (documents.room is NOT NULL since 20260731120000).
        room: DOCUMENT_ROOM.INTERNAL,
        classification,
        min_phase: dataroom.min_phase,
        uploaded_by: auth.user.id,
        dataroom_id: dataroom.id,
        box_file_id: uploaded.id,
        storage_provider: DOCUMENT_STORAGE_PROVIDER.BOX,
        folder,
        folder_subpath: subpath,
      })
      .select('id, name, classification, min_phase, box_file_id, created_at')
      .single();
    if (docError || !document) {
      await discardUpload();
      return jsonError(docError?.message ?? 'Failed to record document', 500);
    }

    const { error: auditError } = await auth.admin.from(TABLE.AUDIT_LOG).insert({
      actor_id: auth.user.id,
      action: AUDIT_ACTION.UPLOAD,
      deal_id: deal.id,
      document_id: document.id,
      detail: {
        stepId,
        boxFileId: uploaded.id,
        fileName: file.name,
        size: file.size,
        folder,
        folderSubpath: subpath,
      },
    });
    if (auditError) {
      const { error: rollbackError } = await auth.admin
        .from(TABLE.DOCUMENTS)
        .delete()
        .eq('id', document.id);
      // A row the delete could not remove (a legal hold, say) still points at
      // this Box file, so the file must stay with it.
      if (rollbackError) {
        console.error('[dataroom] upload unaudited and not rolled back', {
          documentId: document.id,
          boxFileId: uploaded.id,
          code: errorCodeOf(rollbackError),
        });
      } else {
        await discardUpload(document.id);
      }
      return jsonError('Upload could not be audited', 500);
    }

    // Fail open, after the response: the document is stored and audited; tagging can only add to it.
    scheduleDocumentContentTags(auth.admin, document.id, {
      name: file.name,
      type: file.type || null,
      bytes: buffer,
    });

    return NextResponse.json(
      {
        document,
        boxFile: uploaded,
      },
      { status: 201 },
    );
  } catch (err) {
    // Box and Supabase text can quote file and folder names; the response carries a code only.
    return jsonError(`Dataroom storage failed (${errorCodeOf(err)})`, 500);
  }
}
