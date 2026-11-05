import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { TABLE } from '@/lib/constants/tables';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';
import { MVP_DEAL_RAIL, railSeedRows } from '@/lib/rail/dealRail';
import {
  catalogStepsFromSeed,
  railTemplateNameError,
  stepsFromStored,
  summarizeRailTemplates,
  type RailTemplateStepPayload,
  type SavedRailTemplateRow,
  type StoredTemplateStep,
} from '@/lib/rail/railTemplateModel';

export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { data, error } = await auth.admin
    .from(TABLE.RAIL_CATALOG_TEMPLATES)
    .select('id, name, forked_from_id, created_at')
    .eq('company_id', actor.companyId)
    .is('deleted_at', null);

  if (error) return jsonError(error.message, 500);

  const rows = (data ?? []) as Array<{
    id: string;
    name: string;
    forked_from_id: string | null;
    created_at: string;
  }>;
  const counts = new Map<string, number>();
  if (rows.length > 0) {
    const { data: steps, error: stepsError } = await auth.admin
      .from(TABLE.RAIL_CATALOG_STEPS)
      .select('template_id')
      .in(
        'template_id',
        rows.map((row) => row.id),
      );
    if (stepsError) return jsonError(stepsError.message, 500);
    for (const step of (steps ?? []) as Array<{ template_id: string }>) {
      counts.set(step.template_id, (counts.get(step.template_id) ?? 0) + 1);
    }
  }

  const saved: SavedRailTemplateRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    forkedFromId: row.forked_from_id,
    createdAt: row.created_at,
    stepCount: counts.get(row.id) ?? 0,
  }));
  const liveIds = new Set(rows.map((row) => row.id));
  const missingSourceIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.forked_from_id && !liveIds.has(row.forked_from_id) ? [row.forked_from_id] : [],
      ),
    ),
  ];
  const removedSources = new Map<string, string>();
  if (missingSourceIds.length > 0) {
    const { data: sources, error: sourceError } = await auth.admin
      .from(TABLE.RAIL_CATALOG_TEMPLATES)
      .select('id, name')
      .eq('company_id', actor.companyId)
      .in('id', missingSourceIds);
    if (sourceError) return jsonError(sourceError.message, 500);
    for (const source of (sources ?? []) as Array<{ id: string; name: string }>) {
      removedSources.set(source.id, source.name);
    }
  }

  return NextResponse.json({
    templates: summarizeRailTemplates(saved, railSeedRows(MVP_DEAL_RAIL).length, removedSources),
  });
}

type CreateBody = {
  name?: unknown;
  sourceTemplateId?: unknown;
};

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return jsonError('Send a template name and a source.', 400);
  }

  const name = typeof body.name === 'string' ? body.name : '';
  const nameError = railTemplateNameError(name);
  if (nameError) return jsonError(nameError, 400);

  const sourceTemplateId =
    body.sourceTemplateId === null || body.sourceTemplateId === undefined
      ? null
      : body.sourceTemplateId;
  if (sourceTemplateId !== null && typeof sourceTemplateId !== 'string') {
    return jsonError('Start from the house default or a saved template.', 400);
  }
  if (sourceTemplateId !== null && !isUuid(sourceTemplateId)) {
    return jsonError('Start from the house default or a saved template.', 400);
  }

  let steps: RailTemplateStepPayload[];
  if (sourceTemplateId === null) {
    steps = catalogStepsFromSeed(railSeedRows(MVP_DEAL_RAIL));
  } else {
    const { data: source, error: sourceError } = await auth.admin
      .from(TABLE.RAIL_CATALOG_TEMPLATES)
      .select('id')
      .eq('id', sourceTemplateId)
      .eq('company_id', actor.companyId)
      .is('deleted_at', null)
      .maybeSingle();
    if (sourceError) return jsonError(sourceError.message, 500);
    if (!source) return jsonError('Start from a template this company has saved.', 404);

    const { data: stored, error: storedError } = await auth.admin
      .from(TABLE.RAIL_CATALOG_STEPS)
      .select('step_id, seq, phase_index, display_order, origin, definition')
      .eq('template_id', sourceTemplateId);
    if (storedError) return jsonError(storedError.message, 500);
    steps = stepsFromStored((stored ?? []) as StoredTemplateStep[]);
    if (steps.length === 0) {
      return jsonError('That template has no steps to copy.', 409);
    }
  }

  const { data, error } = await auth.admin.rpc('create_rail_template', {
    p_company_id: actor.companyId,
    p_actor_id: auth.user.id,
    p_name: name.trim(),
    p_forked_from: sourceTemplateId,
    p_steps: steps,
  });

  if (error?.code === 'P0002') return jsonError('A template with that name already exists.', 409);
  if (error?.code === 'P0003') {
    return jsonError('Start from a template this company has saved.', 404);
  }
  if (error?.code === 'P0001') return jsonError('Name the template and include its steps.', 400);
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ template: data }, { status: 201 });
}
