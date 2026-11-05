import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireTemplateDraftAccess } from '@/lib/rail/templateSkillDraftAccess';
import { publishTemplateSkillDraft } from '@/lib/rail/templateSkillDrafts';

type RouteContext = { params: Promise<{ templateId: string; draftId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { templateId, draftId } = await context.params;
  if (!isUuid(draftId)) return jsonError('Draft not found.', 404);
  const access = await requireTemplateDraftAccess(templateId);
  if (!access.ok) return access.response;

  let body: { expectedEditRevision?: unknown; candidateId?: unknown; candidateDigest?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError('Generate a candidate skill before saving.', 400);
  }
  if (
    typeof body.expectedEditRevision !== 'number' ||
    typeof body.candidateId !== 'string' ||
    typeof body.candidateDigest !== 'string'
  ) {
    return jsonError('Generate a candidate skill before saving.', 400);
  }

  const result = await publishTemplateSkillDraft(access.admin, {
    companyId: access.companyId,
    authorId: access.userId,
    templateId,
    draftId,
    expectedEditRevision: body.expectedEditRevision,
    candidateId: body.candidateId,
    candidateDigest: body.candidateDigest,
  });
  if ('ok' in result) return jsonError(result.error, result.status);
  return NextResponse.json(result);
}
