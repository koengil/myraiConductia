import { randomUUID } from "node:crypto";

import { isRecord, isUuid } from "@/lib/skillPublication/parse";
import type { SkillBinding } from "@/lib/skillPublication/types";

import { importTemplateSkills } from "./providerClient";
import { TemplateError } from "./types";

export type ChangeSkillPlan = {
  tenantId: string;
  revisionId: string;
  skillKey: string | null;
};

export type StepSkillImport = {
  requestId: string;
  key: string;
  binding: SkillBinding;
};

const UNUSABLE_RECEIPT =
  "The skill service returned a receipt Conductia cannot use.";

export function parseChangeSkillPlan(value: unknown): ChangeSkillPlan | null {
  if (!isRecord(value) || !isUuid(value.tenantId) || !isUuid(value.revisionId)) {
    return null;
  }
  if (value.skillKey === null) {
    return { tenantId: value.tenantId, revisionId: value.revisionId, skillKey: null };
  }
  if (typeof value.skillKey !== "string" || value.skillKey === "") return null;
  return {
    tenantId: value.tenantId,
    revisionId: value.revisionId,
    skillKey: value.skillKey,
  };
}

export async function importAddedStepSkill(input: {
  tenantId: string;
  revisionId: string;
  dealId: string;
  skillKey: string;
}): Promise<StepSkillImport> {
  const requestId = randomUUID();
  const target = {
    key: input.skillKey,
    operationId: randomUUID(),
    skillId: randomUUID(),
    versionId: randomUUID(),
  };
  const receipt = await importTemplateSkills(requestId, {
    companyId: input.tenantId,
    revisionId: input.revisionId,
    projectId: input.dealId,
    targets: [target],
  });

  const imported = receipt.skills[0];
  if (
    receipt.skills.length !== 1 ||
    imported.key !== target.key ||
    imported.binding.skillId !== target.skillId ||
    imported.binding.versionId !== target.versionId
  ) {
    throw new TemplateError("provider_unavailable", UNUSABLE_RECEIPT, 502);
  }
  return { requestId, key: target.key, binding: imported.binding };
}
