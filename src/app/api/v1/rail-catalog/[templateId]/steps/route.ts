import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';
import { housePhases } from '@/lib/rail/railTemplateCatalog';
import { catalogAddPayload } from '@/lib/rail/railTemplateRead';

type RouteContext = { params: Promise<{ templateId: string }> };

type AddBody = {
  kind?: unknown;
  stepId?: unknown;
  title?: unknown;
  description?: unknown;
  phaseIndex?: unknown;
  at?: unknown;
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId } = await context.params;
  if (templateId === 'default') {
    return jsonError('The house template stays as it is. Start a new template to change its steps.', 409);
  }
  if (!isUuid(templateId)) return jsonError('Template not found.', 404);

  let body: AddBody;
  try {
    body = (await request.json()) as AddBody;
  } catch {
    return jsonError('Send the step to add.', 400);
  }

  let payload: {
    stepId: string;
    seq: number | null;
    phaseIndex: number;
    origin: 'catalog' | 'custom';
    definition: { title: string; description: string } | null;
  };
  if (body.kind === 'catalog') {
    if (typeof body.stepId !== 'string') return jsonError('Choose a step from the house rail.', 400);
    const catalog = catalogAddPayload(body.stepId);
    if (!catalog) return jsonError('Choose a step from the house rail.', 400);
    payload = catalog;
  } else if (body.kind === 'custom') {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 120) return jsonError('Name the step.', 400);
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > 4000) return jsonError('Keep the description within 4000 characters.', 400);
    const phaseIndex = body.phaseIndex;
    const known = housePhases().some((phase) => phase.index === phaseIndex);
    if (typeof phaseIndex !== 'number' || !known) return jsonError('Choose a phase for the step.', 400);
    if (body.at !== undefined && (typeof body.at !== 'number' || !Number.isInteger(body.at) || body.at < 1)) {
      return jsonError('Choose where the step goes.', 400);
    }
    payload = {
      stepId: `custom-${crypto.randomUUID()}`,
      seq: null,
      phaseIndex,
      origin: 'custom',
      definition: { title, description },
    };
  } else {
    return jsonError('Send the step to add.', 400);
  }

  const { data, error } = await auth.admin.rpc('add_rail_template_step', {
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_template_id: templateId,
    p_step_id: payload.stepId,
    p_seq: payload.seq,
    p_phase_index: payload.phaseIndex,
    p_origin: payload.origin,
    p_definition: payload.definition,
    p_at: typeof body.at === 'number' ? body.at : null,
  });

  if (error?.code === 'P0002') return jsonError('That step is already on this template.', 409);
  if (error?.code === 'P0003') return jsonError('Template not found.', 404);
  if (error?.code === 'P0001') return jsonError('Send the step to add.', 400);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ step: data }, { status: 201 });
}
