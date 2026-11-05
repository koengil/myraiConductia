import { after, NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireTemplateDraftAccess } from '@/lib/rail/templateSkillDraftAccess';
import { runTemplateAuthoringTurn, submitTemplateSkillMessage } from '@/lib/rail/templateSkillDrafts';
import { authoringUsageRecorder } from '@/lib/skillAuthoring/authoringUsage';

export const maxDuration = 300;

type RouteContext = { params: Promise<{ templateId: string; draftId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { templateId, draftId } = await context.params;
  if (!isUuid(draftId)) return jsonError('Draft not found.', 404);
  const access = await requireTemplateDraftAccess(templateId);
  if (!access.ok) return access.response;

  let body: { expectedEditRevision?: unknown; text?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError('Describe the skill you want to build.', 400);
  }
  if (typeof body.expectedEditRevision !== 'number' || typeof body.text !== 'string') {
    return jsonError('Describe the skill you want to build.', 400);
  }

  const result = await submitTemplateSkillMessage(access.admin, templateId, draftId, {
    expectedEditRevision: body.expectedEditRevision,
    text: body.text,
  });
  if ('ok' in result) return jsonError(result.error, result.status);
  const attemptId = result.attemptId;
  after(() =>
    runTemplateAuthoringTurn(
      access.admin,
      draftId,
      attemptId,
      authoringUsageRecorder(access.admin, { actorId: access.userId, dealId: null }),
    ),
  );
  return NextResponse.json({ created: true, attemptId });
}
