import { formatDate } from '@/lib/format/date';
export const DEFAULT_RAIL_TEMPLATE_NAME = 'Default';
export const RAIL_TEMPLATE_NAME_MAX = 80;

export type RailTemplateStepPayload = {
  stepId: string;
  seq: number | null;
  phaseIndex: number;
  displayOrder: number;
  origin: 'catalog' | 'custom';
  definition: unknown;
};

export type RailSeedLike = {
  stepId: string;
  seq: number;
  phaseIndex: number;
  displayOrder: number;
};

export type StoredTemplateStep = {
  step_id: string;
  seq: number | null;
  phase_index: number;
  display_order: number;
  origin: string;
  definition: unknown;
};

export type SavedRailTemplateRow = {
  id: string;
  name: string;
  forkedFromId: string | null;
  createdAt: string;
  stepCount: number;
};

export type RailTemplateSummary = {
  id: string | null;
  name: string;
  kind: 'default' | 'saved';
  stepCount: number;
  forkedFromName: string | null;
  forkedFromRemoved: boolean;
  createdAt: string | null;
};

export type TemplateStepView = {
  id: string | null;
  stepId: string;
  title: string;
  description: string;
  seq: number | null;
  phaseIndex: number;
  phaseName: string;
  displayOrder: number;
  origin: 'catalog' | 'custom';
  hasSkill: boolean;
};

export type CatalogStepChoice = {
  stepId: string;
  seq: number;
  phaseIndex: number;
  phaseName: string;
  title: string;
  description: string;
};

export function railTemplateNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name the template.';
  if (trimmed.length > RAIL_TEMPLATE_NAME_MAX) {
    return 'Keep the name to 80 characters.';
  }
  if (trimmed.toLowerCase() === DEFAULT_RAIL_TEMPLATE_NAME.toLowerCase()) {
    return 'Default is the house template. Choose another name.';
  }
  return null;
}

export function catalogStepsFromSeed(
  rows: readonly RailSeedLike[],
): RailTemplateStepPayload[] {
  return rows.map((row) => ({
    stepId: row.stepId,
    seq: row.seq,
    phaseIndex: row.phaseIndex,
    displayOrder: row.displayOrder,
    origin: 'catalog',
    definition: null,
  }));
}

export function stepsFromStored(
  rows: readonly StoredTemplateStep[],
): RailTemplateStepPayload[] {
  return [...rows]
    .sort((a, b) => a.display_order - b.display_order)
    .map((row) => ({
      stepId: row.step_id,
      seq: row.seq,
      phaseIndex: row.phase_index,
      displayOrder: row.display_order,
      origin: row.origin === 'custom' ? 'custom' : 'catalog',
      definition: row.definition ?? null,
    }));
}

function textField(definition: unknown, field: 'title' | 'description'): string | null {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
  const value = (definition as { title?: unknown; description?: unknown })[field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function titleFromDefinition(definition: unknown): string | null {
  return textField(definition, 'title');
}

/** A stored description, including a blank one. Null only when the field is absent. */
export function descriptionFromDefinition(definition: unknown): string | null {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
  const value = (definition as { description?: unknown }).description;
  if (typeof value !== 'string') return null;
  return value.trim();
}

export function definitionHasSkill(definition: unknown): boolean {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return false;
  const skill = (definition as { skill?: unknown }).skill;
  return typeof skill === 'object' && skill !== null && !Array.isArray(skill);
}

export function presentTemplateSteps(
  steps: readonly (RailTemplateStepPayload & { id: string | null })[],
  catalog: ReadonlyMap<string, { title: string; phaseName: string; description?: string }>,
  phaseNames: ReadonlyMap<number, string>,
): TemplateStepView[] {
  return [...steps]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((step) => {
      const known = catalog.get(step.stepId);
      return {
        id: step.id,
        stepId: step.stepId,
        title: titleFromDefinition(step.definition) ?? known?.title ?? step.stepId,
        description: descriptionFromDefinition(step.definition) ?? known?.description ?? '',
        seq: step.seq,
        phaseIndex: step.phaseIndex,
        phaseName: phaseNames.get(step.phaseIndex) ?? known?.phaseName ?? `Phase ${step.phaseIndex}`,
        displayOrder: step.displayOrder,
        origin: step.origin,
        hasSkill: definitionHasSkill(step.definition),
      };
    });
}

/** House-rail steps that are not already on this template. */
export function catalogStepsNotOnTemplate(
  catalog: readonly CatalogStepChoice[],
  presentStepIds: ReadonlySet<string>,
): CatalogStepChoice[] {
  return catalog.filter((step) => !presentStepIds.has(step.stepId));
}

/** Default first, then saved templates by name. A null source is the house default. */
export function summarizeRailTemplates(
  saved: readonly SavedRailTemplateRow[],
  defaultStepCount: number,
  removedSources: ReadonlyMap<string, string> = new Map(),
): RailTemplateSummary[] {
  const names = new Map(saved.map((row) => [row.id, row.name]));
  const listed = [...saved].sort((a, b) => a.name.localeCompare(b.name));
  return [
    {
      id: null,
      name: DEFAULT_RAIL_TEMPLATE_NAME,
      kind: 'default',
      stepCount: defaultStepCount,
      forkedFromName: null,
      forkedFromRemoved: false,
      createdAt: null,
    },
    ...listed.map((row) => {
      const liveSource = row.forkedFromId ? names.get(row.forkedFromId) : undefined;
      const removedSource = row.forkedFromId ? removedSources.get(row.forkedFromId) : undefined;
      return {
        id: row.id,
        name: row.name,
        kind: 'saved' as const,
        stepCount: row.stepCount,
        forkedFromName:
          row.forkedFromId === null
            ? DEFAULT_RAIL_TEMPLATE_NAME
            : (liveSource ?? removedSource ?? 'another template'),
        forkedFromRemoved: removedSource !== undefined && liveSource === undefined,
        createdAt: row.createdAt,
      };
    }),
  ];
}

export function startedFromLabel(name: string, removed: boolean): string {
  return removed ? `Started from ${name}, which was removed.` : `Started from ${name}.`;
}

export type TemplatePublication = {
  version: number;
  revisionId: string;
  publishedAt: string;
};

export function publishedLabel(published: TemplatePublication | null): string {
  if (!published) return 'Not published yet';
  const day = formatDate(published.publishedAt);
  return `Version ${published.version} · published ${day}`;
}
