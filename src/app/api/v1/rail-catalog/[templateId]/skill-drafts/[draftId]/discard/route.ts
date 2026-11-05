import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireTemplateDraftAccess } from '@/lib/rail/templateSkillDraftAccess';
import { discardTemplateSkillDraft } from '@/lib/rail/templateSkillDrafts';

type RouteContext = { params: Promise<{ templateId: string; draftId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { templateId, draftId } = await context.params;
  if (!isUuid(draftId)) return jsonError('Draft not found.', 404);
  const access = await requireTemplateDraftAccess(templateId);
  if (!access.ok) return access.response;
  let body: { expectedEditRevision?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError('Could not discard the draft.', 400);
  }
  if (typeof body.expectedEditRevision !== 'number') return jsonError('Could not discard the draft.', 400);
  const result = await discardTemplateSkillDraft(access.admin, templateId, draftId, body.expectedEditRevision);
  if ('error' in result) return jsonError(result.error, result.status);
  return NextResponse.json({ discarded: true });
}
