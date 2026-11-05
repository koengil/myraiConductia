import { NextResponse } from 'next/server';

import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { TABLE } from '@/lib/constants/tables';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';
import {
  presentTemplateChanges,
  type TemplateChangeAction,
  type TemplateChangeRecord,
} from '@/lib/rail/templateChanges';

type RouteContext = { params: Promise<{ templateId: string }> };

const ACTIONS = new Set<TemplateChangeAction>([
  'add_step',
  'remove_step',
  'set_description',
  'set_template_description',
  'set_step_skill',
]);

function actorName(actor: unknown): string {
  const row = Array.isArray(actor) ? actor[0] : actor;
  if (!row || typeof row !== 'object') return 'Someone';
  const name = row as { display_name?: string | null; full_name?: string | null; email?: string | null };
  return name.display_name || name.full_name || name.email || 'Someone';
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return jsonError(actor.error, actor.status);

  const { templateId } = await context.params;
  if (!isUuid(templateId)) return jsonError('Template not found.', 404);

  const { data: template, error: templateError } = await auth.admin
    .from(TABLE.RAIL_CATALOG_TEMPLATES)
    .select('id')
    .eq('id', templateId)
    .eq('company_id', actor.companyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (templateError) return jsonError(templateError.message, 500);
  if (!template) return jsonError('Template not found.', 404);

  const [{ data: rows, error }, { data: steps, error: stepError }] = await Promise.all([
    auth.admin
      .from(TABLE.RAIL_CATALOG_CHANGES)
      .select(
        'id, created_at, action, summary, before, after, undoes_id, actor:users!rail_catalog_changes_actor_id_fkey(display_name, full_name, email)',
      )
      .eq('template_id', templateId)
      .order('created_at', { ascending: false })
      .limit(50),
    auth.admin
      .from(TABLE.RAIL_CATALOG_STEPS)
      .select('id, step_id, phase_index, display_order')
      .eq('template_id', templateId),
  ]);
  if (error) return jsonError(error.message, 500);
  if (stepError) return jsonError(stepError.message, 500);

  const records: TemplateChangeRecord[] = (rows ?? []).flatMap((row) => {
    const action = row.action as TemplateChangeAction;
    if (!ACTIONS.has(action)) return [];
    return [
      {
        id: row.id as string,
        action,
        summary: row.summary as string,
        createdAt: row.created_at as string,
        actorName: actorName(row.actor),
        undoesId: (row.undoes_id as string | null) ?? null,
        before: asObject(row.before),
        after: asObject(row.after),
      },
    ];
  });

  return NextResponse.json({
    changes: presentTemplateChanges(
      records,
      (steps ?? []).map((step) => ({
        id: step.id as string,
        stepId: step.step_id as string,
        phaseIndex: step.phase_index as number,
        displayOrder: step.display_order as number,
      })),
    ),
  });
}
