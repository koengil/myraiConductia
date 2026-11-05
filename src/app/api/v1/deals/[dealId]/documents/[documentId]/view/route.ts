import { NextResponse } from 'next/server';
import { userCanAccessDeal } from '@/lib/api/v1/access';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { getDocumentViewer, userCanOpenDocument } from '@/lib/api/v1/documentAccess';
import { AUDIT_ACTION } from '@/lib/constants/audit';

type RouteContext = { params: Promise<{ dealId: string; documentId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam, documentId } = await context.params;
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

  const { data: document, error: docError } = await auth.admin
    .from('documents')
    .select('id, deal_id, name, room, classification, min_phase')
    .eq('id', documentId)
    .eq('deal_id', dealId)
    .maybeSingle();
  if (docError) return jsonError(docError.message, 500);
  if (!document) return jsonError('Document not found', 404);

  // Flag ON: the full document wall guards the audit path too — a view event
  // must be impossible for a document the viewer cannot see (cr-plan-v1 1.2).
  // Walled-off rows 404 like missing ones: no existence oracle.
  if (await isFlagEnabled('platform_onboarding')) {
    const viewer = await getDocumentViewer(auth.admin, auth.user.id, dealId);
    if (!viewer || !userCanOpenDocument(viewer, document)) {
      return jsonError('Document not found', 404);
    }
  }

  const { data: audit, error: auditError } = await auth.admin
    .from('audit_log')
    .insert({
      actor_id: auth.user.id,
      action: AUDIT_ACTION.VIEW,
      deal_id: dealId,
      document_id: documentId,
      detail: { name: document.name, classification: document.classification },
    })
    .select('id, ts, action, deal_id, document_id')
    .single();
  if (auditError) return jsonError(auditError.message, 500);

  return NextResponse.json({ audit }, { status: 201 });
}
