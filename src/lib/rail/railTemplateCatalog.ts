import { MVP_DEAL_RAIL, phaseForStep, railSeedRows } from '@/lib/rail/dealRail';
import {
  catalogStepsFromSeed,
  type CatalogStepChoice,
  type RailTemplateStepPayload,
} from '@/lib/rail/railTemplateModel';

export function housePhases(): { index: number; name: string }[] {
  return MVP_DEAL_RAIL.map((phase) => ({ index: phase.index, name: phase.name }));
}

export function houseCatalogChoices(): CatalogStepChoice[] {
  return railSeedRows(MVP_DEAL_RAIL).map((row) => {
    const phase = phaseForStep(row.stepId, MVP_DEAL_RAIL);
    const step = phase?.steps.find((item) => item.id === row.stepId);
    return {
      stepId: row.stepId,
      seq: row.seq,
      phaseIndex: row.phaseIndex,
      phaseName: phase?.name ?? `Phase ${row.phaseIndex}`,
      title: step?.title ?? row.stepId,
      description: step?.description ?? '',
    };
  });
}

export function houseTemplateSteps(): Array<RailTemplateStepPayload & { id: null }> {
  return catalogStepsFromSeed(railSeedRows(MVP_DEAL_RAIL)).map((step) => ({
    ...step,
    id: null,
  }));
}

export function catalogChoice(stepId: string): CatalogStepChoice | null {
  return houseCatalogChoices().find((step) => step.stepId === stepId) ?? null;
}
