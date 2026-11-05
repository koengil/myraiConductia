import {
  MVP_DEAL_RAIL,
  railSeedRows,
  type RailSeedRow,
} from "@/lib/rail/dealRail";
import type { SkillBinding } from "@/lib/skillPublication/types";

import type {
  LeftOutCatalogStep,
  RailManifest,
  SeededTemplateStep,
} from "./types";

export function materializeRail(
  manifest: RailManifest,
  ids: Record<string, string>,
  bindings: Record<string, SkillBinding>,
): SeededTemplateStep[] {
  const used = new Set<string>();

  return manifest.steps.map((step) => {
    const id = ids[step.key];
    if (!id || used.has(id)) {
      throw new Error("invalid_step_identity");
    }
    used.add(id);

    const binding = step.skillKey === null ? null : bindings[step.skillKey];
    if (step.skillKey !== null && !binding) {
      throw new Error("missing_skill_import");
    }

    const catalog = step.catalogStepId !== null;
    let definition: SeededTemplateStep["definition"] = null;
    if (!catalog && step.definition !== null) {
      if ("type" in step.definition) {
        if (!binding) {
          throw new Error("missing_skill_import");
        }
        definition = { ...step.definition, skillBinding: binding };
      } else {
        definition = {
          title: step.definition.title,
          description: step.definition.description,
        };
      }
    }

    return {
      id,
      stepId: step.catalogStepId ?? `custom:${id}`,
      origin: catalog ? "catalog" : "custom",
      seq: step.seq,
      phaseIndex: step.phaseIndex,
      displayOrder: step.displayOrder,
      definition,
      binding: binding ?? null,
    };
  });
}

export function leftOutCatalogSteps(
  manifest: RailManifest,
  ids: Record<string, string>,
  standard: readonly RailSeedRow[] = railSeedRows(MVP_DEAL_RAIL),
): LeftOutCatalogStep[] {
  const kept = new Map<string, string | undefined>();
  for (const step of manifest.steps) {
    if (step.catalogStepId !== null) kept.set(step.catalogStepId, ids[step.key]);
  }

  const left: LeftOutCatalogStep[] = [];
  standard.forEach((row, index) => {
    if (kept.has(row.stepId)) return;
    const anchor = standard
      .slice(0, index)
      .reverse()
      .find(
        (earlier) =>
          earlier.phaseIndex === row.phaseIndex && kept.has(earlier.stepId),
      );
    left.push({
      stepId: row.stepId,
      seq: row.seq,
      phaseIndex: row.phaseIndex,
      displayOrder: manifest.steps.length + left.length + 1,
      anchorId: anchor === undefined ? null : (kept.get(anchor.stepId) ?? null),
    });
  });
  return left;
}
