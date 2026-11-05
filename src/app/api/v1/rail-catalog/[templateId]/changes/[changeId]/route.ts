import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';

type RouteContext = { params: Promise<{ templateId: string; changeId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId, changeId } = await context.params;
  if (!isUuid(templateId) || !isUuid(changeId)) return jsonError('That change is not on this template.', 404);

  const { data, error } = await auth.admin.rpc('undo_rail_template_change', {
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_template_id: templateId,
    p_change_id: changeId,
  });

  if (error?.code === 'P0002') return jsonError('That change has already been reversed.', 409);
  if (error?.code === 'P0003') return jsonError('That change is not on this template.', 404);
  if (error?.code === 'P0004') return jsonError('A template needs at least one step.', 409);
  if (error?.code === 'P0001') return jsonError('That change cannot be reversed.', 400);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json(data);
}
