import { NextResponse } from 'next/server';

import { isUuid, jsonError } from '@/lib/api/v1/http';
import { requireTemplateDraftAccess } from '@/lib/rail/templateSkillDraftAccess';
import { parseTemplatePlacement, patchTemplateSkillDraft, readTemplateSkillDraft } from '@/lib/rail/templateSkillDrafts';
import type { Placement } from '@/lib/skillAuthoring/types';

type RouteContext = { params: Promise<{ templateId: string; draftId: string }> };

async function accessFor(context: RouteContext) {
  const { templateId, draftId } = await context.params;
  if (!isUuid(draftId)) return { response: jsonError('Draft not found.', 404) };
  const access = await requireTemplateDraftAccess(templateId);
  if (!access.ok) return { response: access.response };
  return { access, templateId, draftId };
}

export async function GET(_request: Request, context: RouteContext) {
  const ready = await accessFor(context);
  if ('response' in ready) return ready.response;
  const draft = await readTemplateSkillDraft(ready.access.admin, ready.templateId, ready.draftId);
  if (!draft) return jsonError('Draft not found.', 404);
  return NextResponse.json({ draft });
}

export async function PATCH(request: Request, context: RouteContext) {
  const ready = await accessFor(context);
  if ('response' in ready) return ready.response;
  let body: { expectedEditRevision?: unknown; name?: unknown; placement?: unknown; composerText?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError('Send the draft update.', 400);
  }
  if (typeof body.expectedEditRevision !== 'number' || typeof body.name !== 'string' || typeof body.composerText !== 'string') {
    return jsonError('Send the draft update.', 400);
  }
  const placement = body.placement == null ? null : parseTemplatePlacement(body.placement);
  if (body.placement != null && !placement) return jsonError('Choose where the step goes.', 400);
  const result = await patchTemplateSkillDraft(ready.access.admin, ready.templateId, ready.draftId, {
    expectedEditRevision: body.expectedEditRevision,
    name: body.name,
    placement: placement as Placement | null,
    composerText: body.composerText,
  });
  if ('ok' in result) return jsonError(result.error, result.status);
  return NextResponse.json(result);
}
