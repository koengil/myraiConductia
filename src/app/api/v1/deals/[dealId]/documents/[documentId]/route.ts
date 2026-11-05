import { NextResponse } from 'next/server';

import { canManageDealMembers } from '@/lib/api/v1/access';
import { jsonError, requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { forbiddenOrNotVisible } from '@/lib/api/v1/dealNotVisible';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { DOCUMENT_CLASSIFICATION } from '@/lib/constants/documents';

type RouteContext = { params: Promise<{ dealId: string; documentId: string }> };

type DocumentPermissionBody = {
  minPhase?: number;
  classification?: number;
};

/**
 * Assign document disclosure permissions. The deal MD, firm admin, or a member
 * delegated `can_manage_members` may raise or lower min phase and classification.
 */
export async function PATCH(request: Request, context: RouteContext) {
  const gate = await requireFlag('platform_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId: dealParam, documentId } = await context.params;
  const dealRef = await resolveDealRef(auth.admin, dealParam);
  if (!dealRef) return jsonError('Deal not found', 404);
  const dealId = dealRef.id;

  if (!(await canManageDealMembers(auth.admin, auth.user.id, dealId))) {
    return forbiddenOrNotVisible(
      auth.admin,
      auth.user.id,
      dealId,
      'Not allowed to manage document permissions on this deal',
    );
  }

  let body: DocumentPermissionBody;
  try {
    body = (await request.json()) as DocumentPermissionBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const updates: Record<string, number> = {};
  if (body.minPhase !== undefined) {
    if (!Number.isInteger(body.minPhase) || body.minPhase < 0) {
      return jsonError('minPhase must be a non-negative integer', 400);
    }
    updates.min_phase = body.minPhase;
  }
  if (body.classification !== undefined) {
    if (
      !Number.isInteger(body.classification) ||
      body.classification < DOCUMENT_CLASSIFICATION.PUBLIC ||
      body.classification > DOCUMENT_CLASSIFICATION.MNPI
    ) {
      return jsonError('classification must be 1-4', 400);
    }
    updates.classification = body.classification;
  }
  if (Object.keys(updates).length === 0) {
    return jsonError('minPhase and/or classification is required', 400);
  }

  const { data: existing, error: readError } = await auth.admin
    .from('documents')
    .select('id, deal_id, name, room, classification, min_phase')
    .eq('id', documentId)
    .eq('deal_id', dealId)
    .maybeSingle();
  if (readError) return jsonError(readError.message, 500);
  if (!existing) return jsonError('Document not found', 404);

  const { data: updated, error: updateError } = await auth.admin
    .from('documents')
    .update(updates)
    .eq('id', documentId)
    .eq('deal_id', dealId)
    .select('id, name, room, classification, min_phase, uploaded_by, created_at')
    .single();
  if (updateError || !updated) {
    return jsonError(updateError?.message ?? 'Update failed', 500);
  }

  const { error: auditError } = await auth.admin.from('audit_log').insert({
    actor_id: auth.user.id,
    action: AUDIT_ACTION.GRANT,
    deal_id: dealId,
    document_id: documentId,
    detail: {
      reason: 'document_permissions',
      name: existing.name,
      before: {
        minPhase: existing.min_phase,
        classification: existing.classification,
      },
      after: {
        minPhase: updated.min_phase,
        classification: updated.classification,
      },
    },
  });
  if (auditError) return jsonError(auditError.message, 500);

  return NextResponse.json({
    document: {
      id: updated.id,
      name: updated.name,
      room: updated.room,
      classification: updated.classification,
      minPhase: updated.min_phase,
      uploadedBy: updated.uploaded_by,
      createdAt: updated.created_at,
    },
  });
}
