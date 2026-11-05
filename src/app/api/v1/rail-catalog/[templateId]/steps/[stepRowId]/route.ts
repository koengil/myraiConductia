import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';

type RouteContext = { params: Promise<{ templateId: string; stepRowId: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId, stepRowId } = await context.params;
  if (templateId === 'default') {
    return jsonError('The house template stays as it is. Start a new template to change its steps.', 409);
  }
  if (!isUuid(templateId) || !isUuid(stepRowId)) return jsonError('Template not found.', 404);

  const { data, error } = await auth.admin.rpc('remove_rail_template_step', {
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_template_id: templateId,
    p_step_row_id: stepRowId,
  });

  if (error?.code === 'P0004') return jsonError('A template needs at least one step.', 409);
  if (error?.code === 'P0003') return jsonError('That step is not on this template.', 404);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json(data);
}

const DESCRIPTION_MAX = 4000;

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId, stepRowId } = await context.params;
  if (templateId === 'default') {
    return jsonError('The house template stays as it is. Start a new template to change its steps.', 409);
  }
  if (!isUuid(templateId) || !isUuid(stepRowId)) return jsonError('Template not found.', 404);

  let body: { description?: unknown };
  try {
    body = (await request.json()) as { description?: unknown };
  } catch {
    return jsonError('Send the description.', 400);
  }
  if (typeof body.description !== 'string' || body.description.trim().length > DESCRIPTION_MAX) {
    return jsonError('Keep the description within 4000 characters.', 400);
  }

  const { data, error } = await auth.admin.rpc('set_rail_template_step_description', {
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_template_id: templateId,
    p_step_row_id: stepRowId,
    p_description: body.description,
  });

  if (error?.message === 'skill_step_description') {
    return jsonError('A skill step needs a description of 1 to 2,000 characters.', 400);
  }
  if (error?.code === 'P0001') return jsonError('Keep the description within 4000 characters.', 400);
  if (error?.code === 'P0003') return jsonError('That step is not on this template.', 404);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json(data);
}
