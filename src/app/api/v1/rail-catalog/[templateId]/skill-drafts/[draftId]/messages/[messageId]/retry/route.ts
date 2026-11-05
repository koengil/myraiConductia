import { after, NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireTemplateDraftAccess } from '@/lib/rail/templateSkillDraftAccess';
import { retryTemplateSkillMessage, runTemplateAuthoringTurn } from '@/lib/rail/templateSkillDrafts';
import { authoringUsageRecorder } from '@/lib/skillAuthoring/authoringUsage';

export const maxDuration = 300;

type RouteContext = { params: Promise<{ templateId: string; draftId: string; messageId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const { templateId, draftId, messageId } = await context.params;
  if (!isUuid(draftId) || !isUuid(messageId)) return jsonError('Draft not found.', 404);
  const access = await requireTemplateDraftAccess(templateId);
  if (!access.ok) return access.response;
  const result = await retryTemplateSkillMessage(access.admin, templateId, draftId, messageId);
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
