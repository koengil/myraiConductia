import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';
import { readRailTemplate } from '@/lib/rail/railTemplateRead';

type RouteContext = { params: Promise<{ templateId: string }> };

const DESCRIPTION_MAX = 500;

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId } = await context.params;
  if (templateId !== 'default' && !isUuid(templateId)) {
    return jsonError('Template not found.', 404);
  }

  try {
    const detail = await readRailTemplate(auth.admin, actor.companyId, templateId);
    if (detail === 'missing') return jsonError('Template not found.', 404);
    return NextResponse.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read the template.';
    return jsonError(message, 500);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId } = await context.params;
  if (templateId === 'default' || !isUuid(templateId)) {
    return jsonError('The house template stays in the list.', 409);
  }

  const { error } = await auth.admin.rpc('delete_rail_template', {
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_template_id: templateId,
  });
  if (error?.code === 'P0003') return jsonError('Template not found.', 404);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ deleted: true });
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId } = await context.params;
  if (templateId === 'default') {
    return jsonError('The house template stays as it is. Start a new template to describe it.', 409);
  }
  if (!isUuid(templateId)) return jsonError('Template not found.', 404);

  const body = (await request.json().catch(() => null)) as { description?: unknown } | null;
  if (typeof body?.description !== 'string' || body.description.trim().length > DESCRIPTION_MAX) {
    return jsonError('Keep the description within 500 characters.', 400);
  }

  const { data, error } = await auth.admin.rpc('set_rail_template_description', {
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_template_id: templateId,
    p_description: body.description,
  });
  if (error?.code === 'P0001') return jsonError('Keep the description within 500 characters.', 400);
  if (error?.code === 'P0003') return jsonError('Template not found.', 404);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json(data);
}
