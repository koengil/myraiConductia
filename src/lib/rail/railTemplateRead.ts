import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import {
  catalogChoice,
  houseCatalogChoices,
  housePhases,
  houseTemplateSteps,
} from '@/lib/rail/railTemplateCatalog';
import {
  catalogStepsNotOnTemplate,
  presentTemplateSteps,
  stepsFromStored,
  type CatalogStepChoice,
  type RailTemplateStepPayload,
  type StoredTemplateStep,
  type TemplatePublication,
  type TemplateStepView,
} from '@/lib/rail/railTemplateModel';
import { dbFailure } from '@/lib/errors/upstream';
import { isRecord } from '@/lib/skillPublication/parse';

export type RailTemplateDetail = {
  template: {
    id: string | null;
    name: string;
    description: string;
    kind: 'default' | 'saved';
    editable: boolean;
    forkedFromName: string | null;
    forkedFromRemoved: boolean;
  };
  steps: TemplateStepView[];
  availableCatalogSteps: CatalogStepChoice[];
  phases: { index: number; name: string }[];
  published: TemplatePublication | null;
  hasUnpublishedChanges: boolean;
};

type PublicationState = Pick<RailTemplateDetail, 'published' | 'hasUnpublishedChanges'>;

const UNREADABLE_PUBLICATION = 'Could not read the published version.';

function present(
  steps: Array<RailTemplateStepPayload & { id: string | null }>,
): TemplateStepView[] {
  const catalog = new Map(
    houseCatalogChoices().map((step) => [
      step.stepId,
      { title: step.title, phaseName: step.phaseName, description: step.description },
    ]),
  );
  const phaseNames = new Map(housePhases().map((phase) => [phase.index, phase.name]));
  return presentTemplateSteps(steps, catalog, phaseNames);
}

function publishedOf(value: unknown): TemplatePublication | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.version !== 'number' ||
    typeof value.revisionId !== 'string' ||
    typeof value.publishedAt !== 'string'
  ) {
    throw new Error(UNREADABLE_PUBLICATION);
  }
  return { version: value.version, revisionId: value.revisionId, publishedAt: value.publishedAt };
}

async function readPublication(
  admin: SupabaseClient,
  templateId: string,
): Promise<PublicationState> {
  const { data, error } = await admin.rpc('rail_catalog_publication', {
    p_template_id: templateId,
  });
  if (error) throw dbFailure('Rail template save read', error);
  if (!isRecord(data) || typeof data.hasUnpublishedChanges !== 'boolean') {
    throw new Error(UNREADABLE_PUBLICATION);
  }
  return {
    published: publishedOf(data.published),
    hasUnpublishedChanges: data.hasUnpublishedChanges,
  };
}

export async function readRailTemplate(
  admin: SupabaseClient,
  companyId: string,
  templateId: string,
): Promise<RailTemplateDetail | 'missing'> {
  const phases = housePhases();
  if (templateId === 'default') {
    const steps = present(houseTemplateSteps());
    return {
      template: {
        id: null,
        name: 'Default',
        description: '',
        kind: 'default',
        editable: false,
        forkedFromName: null,
        forkedFromRemoved: false,
      },
      steps,
      availableCatalogSteps: [],
      phases,
      published: null,
      hasUnpublishedChanges: false,
    };
  }

  const { data: template, error } = await admin
    .from(TABLE.RAIL_CATALOG_TEMPLATES)
    .select('id, name, forked_from_id, description')
    .eq('id', templateId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw dbFailure('Rail template read', error);
  if (!template) return 'missing';

  const { data: stored, error: stepsError } = await admin
    .from(TABLE.RAIL_CATALOG_STEPS)
    .select('id, step_id, seq, phase_index, display_order, origin, definition')
    .eq('template_id', templateId);
  if (stepsError) throw dbFailure('Rail template steps read', stepsError);

  const rows = ((stored ?? []) as Array<StoredTemplateStep & { id: string }>).map((row) => ({
    ...stepsFromStored([row])[0],
    id: row.id,
  }));
  const steps = present(rows);

  let forkedFromName: string | null = 'Default';
  let forkedFromRemoved = false;
  if (template.forked_from_id) {
    const { data: parent, error: parentError } = await admin
      .from(TABLE.RAIL_CATALOG_TEMPLATES)
      .select('name, deleted_at')
      .eq('id', template.forked_from_id)
      .maybeSingle();
    if (parentError) throw dbFailure('Rail template parent read', parentError);
    forkedFromName = parent?.name ?? 'another template';
    forkedFromRemoved = Boolean(parent?.deleted_at);
  }

  const publication = await readPublication(admin, templateId);

  const presentIds = new Set(steps.map((step) => step.stepId));
  return {
    template: {
      id: template.id as string,
      name: template.name as string,
      description: typeof template.description === 'string' ? template.description : '',
      kind: 'saved',
      editable: true,
      forkedFromName,
      forkedFromRemoved,
    },
    steps,
    availableCatalogSteps: catalogStepsNotOnTemplate(houseCatalogChoices(), presentIds),
    phases,
    ...publication,
  };
}

export function catalogAddPayload(stepId: string): {
  stepId: string;
  seq: number;
  phaseIndex: number;
  origin: 'catalog';
  definition: null;
} | null {
  const choice = catalogChoice(stepId);
  if (!choice) return null;
  return {
    stepId: choice.stepId,
    seq: choice.seq,
    phaseIndex: choice.phaseIndex,
    origin: 'catalog',
    definition: null,
  };
}
