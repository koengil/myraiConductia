import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireTemplateDraftAccess } from '@/lib/rail/templateSkillDraftAccess';
import { openTemplateSkillDraft, parseTemplatePlacement } from '@/lib/rail/templateSkillDrafts';

type RouteContext = { params: Promise<{ templateId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { templateId } = await context.params;
  const access = await requireTemplateDraftAccess(templateId);
  if (!access.ok) return access.response;

  let body: { placement?: unknown } = {};
  try {
    body = (await request.json()) as { placement?: unknown };
  } catch {
    body = {};
  }

  try {
    const draft = await openTemplateSkillDraft(access.admin, {
      companyId: access.companyId,
      authorId: access.userId,
      templateId,
      placement: parseTemplatePlacement(body.placement),
    });
    return NextResponse.json({ draft, basis: null, seedRunId: null });
  } catch {
    return jsonError('Could not open the skill builder.', 500);
  }
}
