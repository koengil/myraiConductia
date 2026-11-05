import { NextResponse } from 'next/server';
import { userCanAccessDeal } from '@/lib/api/v1/access';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { requireFlag, isFlagEnabled } from '@/lib/api/v1/requireFlag';
import {
  getDocumentViewer,
  parseDocumentRoom,
  userCanListDocument,
  userCanListDocumentName,
  userCanOpenDocument,
  userCanUploadDocument,
} from '@/lib/api/v1/documentAccess';
import { errorCodeOf } from '@/lib/errors/upstream';
import { parseDocumentTag, scheduleDocumentContentTags } from '@/lib/compliance/documentTags';
import { getDataRoomStorage } from '@/lib/storage';
import { DOCUMENT_ROOM } from '@/lib/constants/documents';
import { checkDocumentUpload } from '@/lib/validation/inputPolicy';
import {
  DEFAULT_DEAL_FOLDER,
  parseDealFolder,
  parseDealFolderSubpath,
} from '@/lib/dataroom/taxonomy';

type RouteContext = { params: Promise<{ dealId: string }> };

const LIVE_DOCUMENT_COLUMNS =
  'id, name, room, classification, min_phase, uploaded_by, created_at, size_bytes, content_type, storage_file_id, folder, folder_subpath';
const LIVE_DOCUMENT_COLUMNS_WITHOUT_FOLDER =
  'id, name, room, classification, min_phase, uploaded_by, created_at, size_bytes, content_type, storage_file_id';

function isMissingFolderColumn(message: string | undefined): boolean {
  return /column .*folder.* does not exist/i.test(message ?? '');
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam } = await context.params;
  // Flag-off parity (spec c.16): pre-onboarding behavior used the raw route
  // segment; resolve human-readable deal codes only when the flag is on.
  let dealId = dealParam;
  if (await isFlagEnabled('platform_onboarding')) {
    const dealRef = await resolveDealRef(auth.admin, dealParam);
    if (!dealRef) return jsonError('Deal not found', 404);
    dealId = dealRef.id;
  }
  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, dealId);
  if (!allowed) return dealNotVisible();

  const viewer = await getDocumentViewer(auth.admin, auth.user.id, dealId);
  if (!viewer) return dealNotVisible();

  // Flag OFF: the pre-onboarding response shape (spec-v3 criterion 16), but
  // behind the same room and class-4 name walls as the flag-on list (#229).
  if (!(await isFlagEnabled('platform_onboarding'))) {
    const { data, error } = await auth.admin
      .from('documents')
      .select('id, name, room, classification, min_phase, uploaded_by, created_at')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false });
    if (error) return jsonError(error.message, 500);
    type LegacyRow = {
      id: string;
      name: string;
      room: string;
      classification: number;
      min_phase: number;
      uploaded_by: string | null;
      created_at: string;
    };
    const documents = ((data ?? []) as LegacyRow[]).flatMap(({ room: rawRoom, ...doc }) => {
      const room = parseDocumentRoom(rawRoom);
      if (!room) return [];
      const gate = { room, classification: doc.classification, min_phase: doc.min_phase };
      if (!userCanListDocument(viewer, gate) || !userCanListDocumentName(viewer, gate)) return [];
      return [doc];
    });
    return NextResponse.json({ documents });
  }

  // ?tag= narrows to documents whose content was read in full at upload and
  // carries that tag (src/lib/compliance/documentTags.ts).
  const tagParam = new URL(request.url).searchParams.get('tag');
  const tag = tagParam === null ? null : parseDocumentTag(tagParam);
  if (tagParam !== null && !tag) {
    return jsonError('tag must be mnpi, promissory, or lexicon-<category>', 400);
  }
  const listDocuments = (columns: string) => {
    const query = auth.admin.from('documents').select(columns).eq('deal_id', dealId);
    return (tag ? query.contains('content_tags', { tags: [tag] }) : query).order('created_at', {
      ascending: false,
    });
  };

  const withFolder = await listDocuments(LIVE_DOCUMENT_COLUMNS);
  const listedQuery =
    withFolder.error && isMissingFolderColumn(withFolder.error.message)
      ? await listDocuments(LIVE_DOCUMENT_COLUMNS_WITHOUT_FOLDER)
      : withFolder;
  const { data, error } = listedQuery;
  if (error) return jsonError(error.message, 500);

  type ListedRow = {
    id: string;
    name: string;
    room: string;
    classification: number;
    min_phase: number;
    uploaded_by: string | null;
    created_at: string;
    size_bytes: number | null;
    content_type: string | null;
    storage_file_id: string | null;
    folder?: string | null;
    folder_subpath?: string[] | null;
  };
  const rows = (data ?? []) as unknown as ListedRow[];
  const gated = rows.flatMap((doc) => {
    const room = parseDocumentRoom(doc.room);
    if (!room) return [];
    const gate = {
      room,
      classification: doc.classification,
      min_phase: doc.min_phase,
    };
    if (!userCanListDocument(viewer, gate)) return [];
    // A class-4 title can itself be MNPI: drop the row, not just Open, for
    // anyone who is neither the deal MD nor oversight (D1 = B, #78). RLS
    // documents_select hides the same rows.
    if (!userCanListDocumentName(viewer, gate)) return [];
    // A tag describes content: a match is shown only to who may open it.
    if (tag && !userCanOpenDocument(viewer, gate)) return [];
    return [{ doc, gate }];
  });
  return NextResponse.json({
    documents: gated.map(({ doc, gate }) => {
      const canOpen = userCanOpenDocument(viewer, gate);
      return {
        id: doc.id,
        name: doc.name,
        room: gate.room,
        classification: doc.classification,
        minPhase: doc.min_phase,
        uploadedBy: doc.uploaded_by,
        createdAt: doc.created_at,
        sizeBytes: canOpen ? doc.size_bytes : null,
        contentType: canOpen ? doc.content_type : null,
        hasFile: Boolean(doc.storage_file_id),
        canOpen,
        folder: doc.folder ?? DEFAULT_DEAL_FOLDER,
        folderSubpath: Array.isArray(doc.folder_subpath) ? doc.folder_subpath : [],
      };
    }),
  });
}

/**
 * Upload into a room. Bytes go through the storage seam; the DB row is the
 * source of truth, so a storage upload whose row insert fails is compensated
 * with a best-effort remove (cr-plan-v1 5.3). Box unavailability is a
 * retryable HTTP 502 (spec-v3 criterion 9).
 */
export async function POST(request: Request, context: RouteContext) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam } = await context.params;
  // Project URLs address deals by human-readable code; resolve to the
  // canonical UUID before any membership/document query (a raw code would
  // match nothing and read as Forbidden).
  const dealRef = await resolveDealRef(auth.admin, dealParam);
  if (!dealRef) return jsonError('Deal not found', 404);
  const dealId = dealRef.id;
  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, dealId);
  if (!allowed) return dealNotVisible();

  const viewer = await getDocumentViewer(auth.admin, auth.user.id, dealId);
  if (!viewer) return dealNotVisible();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError('Expected multipart form data', 400);
  }
  // FormData entries are File | string; duck-type instead of instanceof —
  // the parsed File comes from undici's realm, not necessarily the global's.
  const file = form.get('file') as File | string | null;
  if (!file || typeof file === 'string') {
    return jsonError('Choose a file to upload.', 400);
  }
  const room = String(form.get('room') ?? DOCUMENT_ROOM.DEAL);
  if (!Object.values(DOCUMENT_ROOM).includes(room as never)) {
    return jsonError('room must be internal or deal', 400);
  }
  const classification = Number(form.get('classification') ?? 2);
  if (!Number.isInteger(classification) || classification < 1 || classification > 4) {
    return jsonError('classification must be 1-4', 400);
  }
  const minPhase = Number(form.get('minPhase') ?? 0);
  if (!Number.isInteger(minPhase) || minPhase < 0) {
    return jsonError('minPhase must be a non-negative integer', 400);
  }
  const accepted = checkDocumentUpload({
    fileName: file.name,
    displayName: String(form.get('name') ?? file.name),
    sizeBytes: file.size,
  });
  if (!accepted.ok) return jsonError(accepted.message, 400);
  const name = accepted.value;

  const folderRaw = form.get('folder');
  const folder =
    folderRaw == null || String(folderRaw).trim() === ''
      ? DEFAULT_DEAL_FOLDER
      : parseDealFolder(folderRaw);
  if (!folder) {
    return jsonError('folder must be one of the eight Deal Folder destinations', 400);
  }
  const subpath = parseDealFolderSubpath(form.get('folderSubpath'));
  if (!subpath) {
    return jsonError('folderSubpath must be at most 3 path segments', 400);
  }

  if (!userCanUploadDocument(viewer, room, classification)) {
    return jsonError('Forbidden', 403);
  }

  const storage = getDataRoomStorage();
  const contentType = file.type || 'application/octet-stream';
  const bytes = new Uint8Array(await file.arrayBuffer());
  let stored;
  try {
    stored = await storage.upload(dealRef.code, room as never, name, contentType, bytes);
  } catch (err) {
    return jsonError(`Storage is unavailable, try again (${errorCodeOf(err)})`, 502);
  }

  // Row + upload audit commit or roll back together (cr-prr-124 3.1); on any
  // RPC failure the stored object is compensated away, so no document row,
  // audit row, or unaudited object survives a mid-flight failure.
  const { data: doc, error: rpcError } = await auth.admin.rpc('create_document_with_audit', {
    p_deal_id: dealId,
    p_name: name,
    p_room: room,
    p_classification: classification,
    p_min_phase: minPhase,
    p_uploaded_by: auth.user.id,
    p_storage_provider: stored.provider,
    p_storage_file_id: stored.fileId,
    p_size_bytes: stored.sizeBytes,
    p_content_type: contentType,
    p_folder: folder,
    p_folder_subpath: subpath,
  });
  if (rpcError || !doc) {
    await storage.remove(stored.fileId).catch(() => {});
    return jsonError(rpcError?.message ?? 'Upload could not be recorded', 500);
  }

  // Fail open, after the response: the document is stored; tagging can only add to it.
  const documentId = (doc as { id?: unknown }).id;
  if (typeof documentId === 'string') {
    scheduleDocumentContentTags(auth.admin, documentId, { name: file.name, type: file.type || null, bytes });
  }

  return NextResponse.json({ document: doc }, { status: 201 });
}
