import type { PublicationMetadata } from "@/lib/skillRun/publicationMetadata";

import { parseSkillStepDefinitionV1 } from "./parse";
import { parseCapabilityContract } from "./parseService";
import { ComparisonSetIntegrityError } from "./comparisonSetIntegrityError";
import { FAILED_PUBLICATION_STATE } from "./types";
import type {
  CapabilityContract,
  ComparisonTarget,
  SkillBinding,
} from "./types";

export type DealStepRow = {
  id: string;
  definition: unknown;
  removed_at: string | null;
};

export type StepBindingRow = {
  deal_step_id: string;
  kind: string;
  skill_id: string | null;
  version_id: string | null;
  digest: string | null;
};

export type OperationRow = {
  id: string;
  name: string;
  capability_contract: unknown;
  candidate_id: string;
  provider_candidate_id: string;
  candidate_digest: string;
  published_skill_id: string | null;
  published_version_id: string | null;
  published_digest: string | null;
  resulting_deal_step_id: string | null;
  state: string;
};

type SkillBindingOutcome =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "ok"; binding: SkillBinding };

function skillBindingOutcome(op: OperationRow): SkillBindingOutcome {
  const fields = [
    op.published_skill_id,
    op.published_version_id,
    op.published_digest,
  ];
  const setCount = fields.filter((field) => field !== null).length;
  if (setCount === 0) return { kind: "none" };
  if (setCount < fields.length) return { kind: "invalid" };
  return {
    kind: "ok",
    binding: {
      skillId: op.published_skill_id as string,
      versionId: op.published_version_id as string,
      digest: op.published_digest as string,
    },
  };
}

function stepTarget(
  step: DealStepRow,
  op: OperationRow,
  capabilityContract: CapabilityContract,
  binding: SkillBinding,
): ComparisonTarget {
  return {
    targetId: step.id,
    state: step.removed_at === null ? "active" : "removed",
    displayName: op.name,
    capabilityContract,
    skillBinding: binding,
    candidate: null,
  };
}

function admittedTarget(
  op: OperationRow,
  capabilityContract: CapabilityContract,
): ComparisonTarget {
  const outcome = skillBindingOutcome(op);
  if (outcome.kind === "invalid") {
    throw new ComparisonSetIntegrityError(op.id, "missing_or_invalid_binding");
  }
  return {
    targetId: op.id,
    state: "admitted",
    displayName: op.name,
    capabilityContract,
    skillBinding: outcome.kind === "ok" ? outcome.binding : null,
    candidate:
      outcome.kind === "ok"
        ? null
        : {
            candidateId: op.provider_candidate_id,
            candidateDigest: op.candidate_digest,
          },
  };
}

export function effectiveStepBindings(
  steps: DealStepRow[],
  bindingByStepId: Map<string, StepBindingRow>,
): Map<string, SkillBinding> {
  const bindings = new Map<string, SkillBinding>();
  for (const step of steps) {
    const row = bindingByStepId.get(step.id);
    if (row !== undefined) {
      const selected = selectedBinding(row);
      if (selected !== null) bindings.set(step.id, selected);
      continue;
    }
    const definition = parseSkillStepDefinitionV1(step.definition);
    if ("error" in definition) continue;
    bindings.set(step.id, definition.skillBinding);
  }
  return bindings;
}

function selectedBinding(row: StepBindingRow): SkillBinding | null {
  if (row.kind !== "publication") return null;
  if (
    typeof row.skill_id !== "string" ||
    typeof row.version_id !== "string" ||
    typeof row.digest !== "string"
  ) {
    return null;
  }
  return {
    skillId: row.skill_id,
    versionId: row.version_id,
    digest: row.digest,
  };
}

export function importedComparisonTarget(
  stepId: string,
  removed: boolean,
  metadata: PublicationMetadata,
  binding: SkillBinding,
): ComparisonTarget {
  return {
    targetId: stepId,
    state: removed ? "removed" : "active",
    displayName: metadata.name,
    capabilityContract: metadata.contract,
    skillBinding: binding,
    candidate: null,
  };
}

export function bindingKey(binding: SkillBinding): string {
  return `${binding.skillId}:${binding.versionId}:${binding.digest}`;
}

function operationsByBinding(
  operations: OperationRow[],
): Map<string, OperationRow> {
  const byBinding = new Map<string, OperationRow>();
  for (const op of operations) {
    const outcome = skillBindingOutcome(op);
    if (outcome.kind !== "ok") continue;
    byBinding.set(bindingKey(outcome.binding), op);
  }
  return byBinding;
}

export function buildStepTargets(
  steps: DealStepRow[],
  bindingByStepId: Map<string, SkillBinding>,
  operations: OperationRow[],
  metadataByBinding: Map<string, PublicationMetadata>,
): ComparisonTarget[] {
  const operationByBinding = operationsByBinding(operations);
  const targets: ComparisonTarget[] = [];
  for (const step of steps) {
    const binding = bindingByStepId.get(step.id);
    if (binding === undefined) continue;
    const key = bindingKey(binding);
    const op = operationByBinding.get(key);
    if (op !== undefined) {
      const capabilityContract = parseCapabilityContract(
        op.capability_contract,
      );
      if (capabilityContract === null) {
        throw new ComparisonSetIntegrityError(
          step.id,
          "unparseable_capability_contract",
        );
      }
      targets.push(stepTarget(step, op, capabilityContract, binding));
      continue;
    }
    const removed = step.removed_at !== null;
    const imported = metadataByBinding.get(key);
    if (imported === undefined) {
      if (removed) continue;
      throw new ComparisonSetIntegrityError(
        step.id,
        "missing_or_invalid_binding",
      );
    }
    targets.push(
      importedComparisonTarget(step.id, removed, imported, binding),
    );
  }
  return targets;
}

export function buildAdmittedTargets(
  operations: OperationRow[],
  operationId: string,
): ComparisonTarget[] {
  const targets: ComparisonTarget[] = [];
  for (const op of operations) {
    if (op.id === operationId) continue;
    if (op.state === FAILED_PUBLICATION_STATE) continue;
    if (op.resulting_deal_step_id !== null) continue;
    const capabilityContract = parseCapabilityContract(op.capability_contract);
    if (capabilityContract === null) {
      throw new ComparisonSetIntegrityError(
        op.id,
        "unparseable_capability_contract",
      );
    }
    targets.push(admittedTarget(op, capabilityContract));
  }
  return targets;
}
