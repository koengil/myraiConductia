import {
  type RailTemplateSummary,
  type TemplatePublication,
} from '@/lib/rail/railTemplateModel';

/**
 * Rails configuration read model: what the list, the new template dialog and
 * the publish bar say. Pure functions over the existing GET /rail-catalog
 * and GET /rail-catalog/[id] responses; nothing here reads or writes.
 */

export type TemplateGroup = {
  id: 'built-in' | 'saved';
  label: string;
  templates: RailTemplateSummary[];
};

/** Whether a template's name matches a search. Blank matches everything. */
export function matchesTemplateSearch(template: RailTemplateSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return template.name.toLowerCase().includes(needle);
}

/**
 * The list in two groups, filtered by name: the built-in Default, then the
 * templates this firm saved (the API already sorts them by name). A group
 * with nothing left after the search is dropped.
 */
export function groupTemplates(
  templates: readonly RailTemplateSummary[],
  query: string,
): TemplateGroup[] {
  const shown = templates.filter((template) => matchesTemplateSearch(template, query));
  const groups: TemplateGroup[] = [
    { id: 'built-in', label: 'Built in', templates: shown.filter((t) => t.kind === 'default') },
    { id: 'saved', label: 'Saved by your firm', templates: shown.filter((t) => t.kind === 'saved') },
  ];
  return groups.filter((group) => group.templates.length > 0);
}

function stepsPhrase(count: number): string {
  return count === 1 ? '1 step' : `${count} steps`;
}

function comeAcross(count: number): string {
  return `its ${stepsPhrase(count)} ${count === 1 ? 'comes' : 'come'} across`;
}

/**
 * The line the new template dialog shows before "Create template": what the
 * new template starts with. POST /rail-catalog copies the built-in Default
 * rail when no source is chosen, else the chosen template's steps.
 */
export function startingPointLine(
  sourceId: string,
  templates: readonly RailTemplateSummary[],
): string {
  const source = sourceId ? templates.find((t) => t.id === sourceId) : undefined;
  if (source) {
    return `Starts as a copy of ${source.name}, and ${comeAcross(source.stepCount)} in their phases. ${source.name} stays as it is.`;
  }
  const builtIn = templates.find((t) => t.kind === 'default');
  const steps = builtIn ? comeAcross(builtIn.stepCount) : 'its steps come across';
  return `Starts from your default rail. A new deal gets it unless someone picks a template, and ${steps} in their phases.`;
}

/** The meta line under a template's name in the list. */
export function templateMeta(template: RailTemplateSummary): string {
  if (template.kind === 'default') {
    return `Built into Conductia · ${stepsPhrase(template.stepCount)}`;
  }
  const source = template.forkedFromName ?? 'another template';
  const from = template.forkedFromRemoved ? `Started from ${source}, since removed` : `Started from ${source}`;
  return `${from} · ${stepsPhrase(template.stepCount)}`;
}

/**
 * Who gets a publish, from what publishing does: the published version is
 * the one Gate 0 offers new deals (only published templates are offered).
 * With template change review on, open deals already built from this
 * template get a notice and their team accepts or discards each added or
 * removed step; nothing changes on those deals until then. With it off, open
 * deals keep the rail they started with.
 */
export function publishAudience(
  name: string,
  published: TemplatePublication | null,
  changeReviewOn: boolean,
): string {
  if (!published) {
    return `Publishing lets new deals start from ${name}. No deal uses it yet.`;
  }
  const newDeals = `New deals that start from ${name} get the published version.`;
  if (!changeReviewOn) {
    return `${newDeals} Open deals keep the rail they started with.`;
  }
  return `${newDeals} Open deals on ${name} get a notice, and their team accepts or discards each added or removed step. Nothing changes on those deals until they choose.`;
}
