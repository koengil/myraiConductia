import { randomUUID } from "node:crypto";

import { PROTECTED_STEP_IDS } from "@/lib/rail/protectedSteps";
import {
  hasExactKeys,
  isRecord,
  parseSkillStepDefinitionV1,
} from "@/lib/skillPublication/parse";
import type { CapabilityContract } from "@/lib/skillPublication/types";
import type { SkillReference } from "@/lib/skillRun/types";

import { parseTemplateSkillSource } from "./skillSource";
import type { TemplateSkillSource } from "./types";

export type DraftSkill = {
  reference: SkillReference;
  name: string;
  contract: CapabilityContract;
};

export type DraftSourceStep = {
  id: string;
  stepId: string;
  origin: "catalog" | "custom";
  seq: number | null;
  phaseIndex: number | null;
  displayOrder: number | null;
  definition: unknown;
  templateStepKey: string | null;
  skill: DraftSkill | null;
};

export type TargetStep = {
  stepId: string;
  skill: Record<string, unknown> | null;
  retainedDigest: string | null;
};

export type RailDraftStep = {
  dealStepId: string;
  stepId: string;
  origin: "catalog" | "custom";
  seq: number | null;
  phaseIndex: number;
  definition: Record<string, unknown> | null;
};

export type RailDraft = {
  steps: RailDraftStep[];
  skills: Array<{ key: string; source: TemplateSkillSource }>;
};

type DraftOptions = {
  protectedIds?: ReadonlySet<string>;
  mintStepId?: () => string;
};

const SKILL_DESCRIPTION_LIMIT = 2000;
const STEP_DESCRIPTION_LIMIT = 4000;

function catalogLength(text: string): number {
  return [...text.replace(/^ +| +$/g, "")].length;
}

function skillBlock(
  skill: DraftSkill,
  target: TargetStep | undefined,
): Record<string, unknown> {
  if (
    target !== undefined &&
    target.skill !== null &&
    target.retainedDigest !== null &&
    target.retainedDigest === skill.reference.digest
  ) {
    return target.skill;
  }
  return { name: skill.name, contract: skill.contract, source: skill.reference };
}

function customDefinition(
  definition: unknown,
  block: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!isRecord(definition)) throw new Error("unsupported_definition");
  if (
    hasExactKeys(definition, ["title", "description"]) &&
    typeof definition.title === "string" &&
    typeof definition.description === "string"
  ) {
    if (catalogLength(definition.description) > STEP_DESCRIPTION_LIMIT) {
      throw new Error("step_description_too_long");
    }
    return { title: definition.title, description: definition.description };
  }
  if (definition.type === "skill" && typeof definition.description === "string") {
    const length = catalogLength(definition.description);
    if (length < 1 || length > SKILL_DESCRIPTION_LIMIT) {
      throw new Error("skill_step_description");
    }
  }
  const parsed = parseSkillStepDefinitionV1(definition);
  if ("error" in parsed) throw new Error("unsupported_definition");
  if (block === null) throw new Error("skill_unavailable");
  return {
    schemaVersion: parsed.schemaVersion,
    type: parsed.type,
    title: parsed.title,
    description: parsed.description,
    inputs: parsed.inputs,
    skill: block,
  };
}

function sourceKey(source: TemplateSkillSource): string {
  const fields = source as unknown as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((field) => [field, fields[field]]),
  );
}

export function buildRailDraft(
  steps: DraftSourceStep[],
  target: TargetStep[] | null,
  options: DraftOptions = {},
): RailDraft {
  const protectedIds = options.protectedIds ?? PROTECTED_STEP_IDS;
  const mintStepId = options.mintStepId ?? (() => `custom-${randomUUID()}`);
  const targets = new Map((target ?? []).map((step) => [step.stepId, step]));
  const ordered = [...steps].sort(
    (a, b) =>
      (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.id.localeCompare(b.id),
  );
  if (ordered.length === 0) throw new Error("empty_rail");

  const houseIds = new Set<string>();
  const stepIds = new Set<string>();
  const skillKeys = new Map<string, string>();
  const skills: RailDraft["skills"] = [];

  const drafted = ordered.map((step): RailDraftStep => {
    if (step.phaseIndex === null || step.displayOrder === null) {
      throw new Error("unstructured_rail");
    }
    if (
      !Number.isInteger(step.phaseIndex) ||
      step.phaseIndex < 1 ||
      !Number.isInteger(step.displayOrder) ||
      step.displayOrder < 1
    ) {
      throw new Error("invalid_step_order");
    }
    if (step.origin === "catalog") {
      if (houseIds.has(step.stepId)) throw new Error("duplicate_catalog_step");
      houseIds.add(step.stepId);
    }

    const stepId =
      step.origin === "catalog"
        ? step.stepId
        : (step.templateStepKey ?? mintStepId());
    if (stepIds.has(stepId)) throw new Error("duplicate_step_key");
    stepIds.add(stepId);

    const block =
      step.skill === null ? null : skillBlock(step.skill, targets.get(stepId));
    const definition =
      step.origin === "catalog"
        ? block === null
          ? null
          : { skill: block }
        : customDefinition(step.definition, block);

    if (definition !== null && isRecord(definition.skill)) {
      const source = parseTemplateSkillSource(definition.skill.source);
      if (source === null) throw new Error("skill_unavailable");
      const canonical = sourceKey(source);
      if (!skillKeys.has(canonical)) {
        const key = `s${skills.length}`;
        skillKeys.set(canonical, key);
        skills.push({ key, source });
      }
    }

    return {
      dealStepId: step.id,
      stepId,
      origin: step.origin,
      seq: step.origin === "catalog" ? step.seq : null,
      phaseIndex: step.phaseIndex,
      definition,
    };
  });

  for (const protectedId of protectedIds) {
    if (!houseIds.has(protectedId)) throw new Error("missing_protected_step");
  }

  return { steps: drafted, skills };
}
