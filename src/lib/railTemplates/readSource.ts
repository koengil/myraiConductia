import type { SupabaseClient } from "@supabase/supabase-js";

import { STEP_STATUSES, type StepStatus } from "@/lib/constants/dealSteps";
import { DEAL_RAIL, orderedSteps, type RailStep } from "@/lib/rail/dealRail";
import type { ProjectRailStep } from "@/lib/rail/projectRail";
import { isRecord } from "@/lib/skillPublication/parse";
import type { CapabilityContract } from "@/lib/skillPublication/types";
import { readPublicationMetadataBatch } from "@/lib/skillRun/publicationMetadata";
import { resolveStepBinding } from "@/lib/skillRun/step";
import type { SkillReference } from "@/lib/skillRun/types";

import type { DraftSourceStep } from "./railDraft";
import { TemplateError, type TemplateSkill } from "./types";
import { dbFailure } from '@/lib/errors/upstream';

const FALLBACK_INPUT = "Banker-provided text input";
const FALLBACK_OUTPUT = "Skill-generated result";

const CENSUS_STEPS = new Map(
  orderedSteps(DEAL_RAIL).map((step) => [step.id, step]),
);

export async function readRailSource(
  admin: SupabaseClient,
  actorId: string,
  dealId: string,
): Promise<{ steps: DraftSourceStep[]; sourceFingerprint: string }> {
  const source = await readSource(admin, actorId, dealId);
  const bindings = bindingsByStep(source.bindings);
  const resolved = source.steps
    .filter((step) => step.removedAt === null)
    .map((step) => {
      const binding = resolveStepBinding(
        {
          id: step.id,
          step_id: step.stepId,
          origin: step.origin,
          removed_at: null,
          definition: step.definition,
        },
        bindings.get(step.id) ?? null,
        null,
        null,
        null,
      );
      return { step, reference: binding.ok ? binding.step.binding : null };
    });

  const metadata = await readPublicationMetadataBatch(
    admin,
    dealId,
    resolved.flatMap(({ reference }) =>
      reference?.kind === "publication" ? [reference] : [],
    ),
  );

  return {
    sourceFingerprint: source.sourceFingerprint,
    steps: resolved.map(({ step, reference }) => {
      const skill =
        reference === null ? null : effectiveSkill(step, reference, metadata);
      return {
        id: step.id,
        stepId: step.stepId,
        origin: step.origin,
        seq: step.seq,
        phaseIndex: step.phaseIndex,
        displayOrder: step.displayOrder,
        definition: step.definition,
        templateStepKey: step.templateStepKey,
        skill:
          skill === null
            ? null
            : { reference: skill.source, name: skill.name, contract: skill.contract },
      };
    }),
  };
}

function effectiveSkill(
  step: RawStep,
  reference: SkillReference,
  metadata: Awaited<ReturnType<typeof readPublicationMetadataBatch>>,
): Omit<TemplateSkill, "key"> {
  if (reference.kind === "mount") {
    return {
      source: reference,
      name: reference.name,
      contract: catalogContract(step.stepId),
    };
  }
  const known = metadata.get(reference.versionId);
  if (!known) {
    throw new TemplateError(
      "skill_unavailable",
      "A skill on this rail is no longer available to copy.",
    );
  }
  return { source: reference, name: known.name, contract: known.contract };
}

function catalogContract(stepId: string): CapabilityContract {
  const census = CENSUS_STEPS.get(stepId);
  const purpose = census?.description.trim() ?? "";
  if (purpose === "") {
    throw new TemplateError(
      "skill_unavailable",
      "A standard step on this rail has no catalog description to copy.",
    );
  }
  return {
    purpose,
    expectedInput: joined(census, "inputs") || FALLBACK_INPUT,
    expectedOutput: joined(census, "outputs") || FALLBACK_OUTPUT,
  };
}

function joined(
  census: RailStep | undefined,
  side: "inputs" | "outputs",
): string {
  return (census?.io[side] ?? [])
    .map((item) => item.what.trim())
    .filter((what) => what !== "")
    .join("\n");
}

type RawStep = {
  id: string;
  stepId: string;
  origin: "catalog" | "custom";
  seq: number | null;
  status: StepStatus;
  phaseIndex: number | null;
  displayOrder: number | null;
  definition: ProjectRailStep["definition"];
  templateStepKey: string | null;
  removedAt: string | null;
};

type RawBinding = {
  dealStepId: string;
  kind: unknown;
  skill_id: unknown;
  version_id: unknown;
  mount_name: unknown;
  mount_version: unknown;
  digest: unknown;
};

type Source = {
  censusVersion: string;
  steps: RawStep[];
  bindings: RawBinding[];
  sourceFingerprint: string;
};

async function readSource(
  admin: SupabaseClient,
  actorId: string,
  dealId: string,
): Promise<Source> {
  const { data, error } = await admin.rpc("rail_template_read_source", {
    p_actor_id: actorId,
    p_deal_id: dealId,
  });
  if (error) throw dbFailure('Rail template source read', error);
  if (!isRecord(data) || typeof data.sourceFingerprint !== "string") {
    throw new Error("rail_template_response_invalid");
  }
  if (typeof data.censusVersion !== "string" || data.censusVersion === "") {
    throw new TemplateError(
      "invalid_command",
      "This rail has no census version to save against.",
    );
  }
  return {
    censusVersion: data.censusVersion,
    steps: (Array.isArray(data.steps) ? data.steps : []).map(rawStep),
    bindings: (Array.isArray(data.bindings) ? data.bindings : []).map(
      rawBinding,
    ),
    sourceFingerprint: data.sourceFingerprint,
  };
}

function rawStep(value: unknown): RawStep {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.stepId !== "string" ||
    !isStepStatus(value.status)
  ) {
    throw new Error("rail_template_response_invalid");
  }
  return {
    id: value.id,
    stepId: value.stepId,
    origin: value.origin === "catalog" ? "catalog" : "custom",
    seq: typeof value.seq === "number" ? value.seq : null,
    status: value.status,
    phaseIndex: position(value.phaseIndex),
    displayOrder: position(value.displayOrder),
    definition: (value.definition ?? null) as RawStep["definition"],
    templateStepKey:
      typeof value.templateStepKey === "string" ? value.templateStepKey : null,
    removedAt: typeof value.removedAt === "string" ? value.removedAt : null,
  };
}

function isStepStatus(value: unknown): value is StepStatus {
  return (STEP_STATUSES as readonly string[]).includes(value as string);
}

function position(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("rail_template_response_invalid");
  }
  return value;
}

function rawBinding(value: unknown): RawBinding {
  if (!isRecord(value)) throw new Error("rail_template_response_invalid");
  return {
    dealStepId: String(value.dealStepId),
    kind: value.kind,
    skill_id: value.skillId,
    version_id: value.versionId,
    mount_name: value.mountName,
    mount_version: value.mountVersion,
    digest: value.digest,
  };
}

function bindingsByStep(bindings: RawBinding[]): Map<string, RawBinding> {
  return new Map(bindings.map((binding) => [binding.dealStepId, binding]));
}
