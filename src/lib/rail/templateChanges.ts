import { catalogChoice } from '@/lib/rail/railTemplateCatalog';
import type { Placement } from '@/lib/skillAuthoring/types';

export type TemplateStepOrder = {
  id: string | null;
  stepId: string;
  phaseIndex: number;
  displayOrder: number;
};

export type TemplateChangeAction =
  | 'add_step'
  | 'remove_step'
  | 'set_description'
  | 'set_template_description'
  | 'set_step_skill';

export type TemplateChangeRecord = {
  id: string;
  action: TemplateChangeAction;
  summary: string;
  createdAt: string;
  actorName: string;
  undoesId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export type TemplateChangeView = TemplateChangeRecord & { canUndo: boolean };

export function displayOrderForPlacement(
  steps: readonly TemplateStepOrder[],
  placement: Placement,
): number | null {
  const ordered = [...steps].sort((a, b) => a.displayOrder - b.displayOrder);
  const inPhase = ordered.filter((step) => step.phaseIndex === placement.phaseIndex);
  if (placement.kind === 'after') {
    const anchor = ordered.find((step) => step.id === placement.afterStepId);
    return anchor ? anchor.displayOrder + 1 : null;
  }
  if (placement.kind === 'phase_start') {
    if (inPhase[0]) return inPhase[0].displayOrder;
    const later = ordered.find((step) => step.phaseIndex > placement.phaseIndex);
    if (later) return later.displayOrder;
    return (ordered.at(-1)?.displayOrder ?? 0) + 1;
  }
  if (inPhase.length > 0) return inPhase[inPhase.length - 1].displayOrder + 1;
  const later = ordered.find((step) => step.phaseIndex > placement.phaseIndex);
  if (later) return later.displayOrder;
  return (ordered.at(-1)?.displayOrder ?? 0) + 1;
}

function withoutSkillBlock(side: Record<string, unknown> | null): Record<string, unknown> | null {
  const definition = side?.definition;
  if (!side || typeof definition !== 'object' || definition === null || !('skill' in definition)) {
    return side;
  }
  const rest = { ...(definition as Record<string, unknown>) };
  delete rest.skill;
  return { ...side, definition: rest };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function summaryWithHouseTitle(change: TemplateChangeRecord): string {
  const stepId = text(change.before?.stepId) ?? text(change.after?.stepId);
  if (stepId === null) return change.summary;
  const title = catalogChoice(stepId)?.title;
  if (!title || title === stepId) return change.summary;
  return change.summary.replaceAll(`"${stepId}"`, `"${title}"`);
}

/** Undo writes a new change that reverses one earlier change. */
export function presentTemplateChanges(
  changes: readonly TemplateChangeRecord[],
  steps: readonly TemplateStepOrder[],
): TemplateChangeView[] {
  const undone = new Set(changes.flatMap((change) => (change.undoesId ? [change.undoesId] : [])));
  const ids = new Set(steps.flatMap((step) => (step.id ? [step.id] : [])));
  const keys = new Set(steps.map((step) => step.stepId));
  return changes.map((change) => ({
    ...change,
    summary: summaryWithHouseTitle(change),
    before: withoutSkillBlock(change.before),
    after: withoutSkillBlock(change.after),
    canUndo: !undone.has(change.id) && reversible(change, ids, keys, steps.length),
  }));
}

function reversible(
  change: TemplateChangeRecord,
  ids: ReadonlySet<string>,
  keys: ReadonlySet<string>,
  stepCount: number,
): boolean {
  if (change.action === 'add_step') {
    const stepRowId = text(change.after?.stepRowId);
    return stepCount > 1 && stepRowId !== null && ids.has(stepRowId);
  }
  if (change.action === 'remove_step') {
    const stepId = text(change.before?.stepId);
    return stepId !== null && !keys.has(stepId);
  }
  if (change.action === 'set_description') {
    const stepRowId = text(change.after?.stepRowId);
    return stepRowId !== null && ids.has(stepRowId);
  }
  if (change.action === 'set_template_description') {
    return true;
  }
  if (change.action === 'set_step_skill') {
    const stepRowId = text(change.after?.stepRowId);
    return stepRowId !== null && ids.has(stepRowId);
  }
  return false;
}
