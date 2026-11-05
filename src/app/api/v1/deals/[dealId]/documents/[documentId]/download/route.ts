import { userCanAccessDeal } from '@/lib/api/v1/access';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { getDocumentViewer, userCanOpenDocument } from '@/lib/api/v1/documentAccess';
import { contentDispositionAttachment } from '@/lib/http/contentDisposition';
import { errorCodeOf } from '@/lib/errors/upstream';
import { getDataRoomStorage } from '@/lib/storage';
import { AUDIT_ACTION } from '@/lib/constants/audit';

type RouteContext = { params: Promise<{ dealId: string; documentId: string }> };

/**
 * Stream a document through the platform (Conductia-mediated: the user never
 * touches storage directly). The full wall — deal access, room, MNPI, phase —
 * runs first; the download audit lands BEFORE bytes flow.
 */
export async function GET(_request: Request, context: RouteContext) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam, documentId } = await context.params;
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

  const { data: doc, error } = await auth.admin
    .from('documents')
    .select('id, deal_id, name, room, classification, min_phase, storage_file_id, content_type')
    .eq('id', documentId)
    .eq('deal_id', dealId)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  // Direct-ID probes get the same 404 whether the row is missing or walled
  // off — no existence oracle.
  if (!doc || !userCanOpenDocument(viewer, doc)) {
    return jsonError('Document not found', 404);
  }
  if (!doc.storage_file_id) {
    return jsonError('This document has no stored file', 409);
  }

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.DOWNLOAD,
    deal_id: dealId,
    document_id: doc.id,
    detail: { name: doc.name, room: doc.room, classification: doc.classification },
  });
  if (auditError) return jsonError(auditError.message, 500);

  try {
    const stream = await getDataRoomStorage().downloadStream(doc.storage_file_id);
    return new Response(stream, {
      headers: {
        'Content-Type': doc.content_type ?? 'application/octet-stream',
        'Content-Disposition': contentDispositionAttachment(doc.name),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return jsonError(`Storage is unavailable, try again (${errorCodeOf(err)})`, 502);
  }
}
