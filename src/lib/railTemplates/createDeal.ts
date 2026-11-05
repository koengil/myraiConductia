import type { SupabaseClient } from "@supabase/supabase-js";

import { isFlagEnabled } from "@/lib/api/v1/requireFlag";
import {
  gate0BodyOf,
  gate0InputMatches,
  validateGate0Input,
  type ValidatedGate0Input,
} from "@/lib/deals/createDealInput";
import { isUuid } from "@/lib/skillPublication/parse";

import { requireTemplateUse } from "./access";
import {
  admitCreation,
  finalizeCreation,
  readCreation,
  readCreationTemplateId,
  seedLeftOutSteps,
} from "./creationRepository";
import { importTemplateSkills } from "./providerClient";
import {
  TemplateError,
  withTemplateErrors,
  type CreationAdmission,
  type Gate0CreateReceipt,
  type ImportReceipt,
  type TemplateSelection,
} from "./types";

export type CreationStatus = {
  selection: TemplateSelection;
  input: ValidatedGate0Input;
  state: CreationAdmission["state"];
};

export function parseTemplateSelection(value: unknown): TemplateSelection {
  const selection = value as Partial<TemplateSelection> | null | undefined;
  if (!selection || !isUuid(selection.templateId) || !isUuid(selection.revisionId)) {
    throw new TemplateError("invalid_command", "This saved rail is not usable.");
  }
  return {
    templateId: selection.templateId,
    revisionId: selection.revisionId,
  };
}

export async function createDealFromTemplate(
  admin: SupabaseClient,
  input: ValidatedGate0Input,
  selection: TemplateSelection,
  requestId: string,
): Promise<Gate0CreateReceipt> {
  if (!isUuid(requestId)) {
    throw new TemplateError("invalid_command", "This creation request is not usable.");
  }
  await assertCreationScope(admin, input);
  const admission = await withTemplateErrors(() =>
    admitCreation(admin, input, selection, requestId),
  );
  return complete(admin, input.actorId, admission);
}

export async function resumeDealCreation(
  admin: SupabaseClient,
  actorId: string,
  requestId: string,
): Promise<Gate0CreateReceipt> {
  const admission = await readAdmission(admin, actorId, requestId);
  const settled = await settledReceipt(admin, admission);
  if (settled) return settled;
  await revalidate(admin, admission);
  return complete(admin, actorId, admission);
}

export async function readDealCreation(
  admin: SupabaseClient,
  actorId: string,
  requestId: string,
): Promise<CreationStatus | null> {
  const admission = await readCreation(admin, actorId, requestId);
  if (admission === null) return null;
  const scope = await requireTemplateUse(admin, actorId);
  if (scope.companyId !== admission.companyId) {
    throw new TemplateError("not_found", "That mandate is no longer pending.");
  }
  const templateId = await readCreationTemplateId(admin, admission.revisionId);
  if (templateId === null) {
    throw new TemplateError("not_found", "That mandate is no longer pending.");
  }
  return {
    selection: { templateId, revisionId: admission.revisionId },
    input: admission.input,
    state: admission.state,
  };
}

async function readAdmission(
  admin: SupabaseClient,
  actorId: string,
  requestId: string,
): Promise<CreationAdmission> {
  const admission = await readCreation(admin, actorId, requestId);
  if (admission === null) {
    throw new TemplateError("not_found", "That mandate is no longer pending.");
  }
  return admission;
}

async function assertCreationScope(
  admin: SupabaseClient,
  input: ValidatedGate0Input,
): Promise<void> {
  const scope = await requireTemplateUse(admin, input.actorId);
  if (scope.companyId !== input.bankId) {
    throw new TemplateError(
      "forbidden",
      "This company rail is not available to you.",
    );
  }
}

async function revalidate(
  admin: SupabaseClient,
  admission: CreationAdmission,
): Promise<void> {
  await assertCreationScope(admin, admission.input);
  const revalidated = await validateGate0Input(
    admin,
    admission.actorId,
    gate0BodyOf(admission.input),
  );
  if (!revalidated.ok || !gate0InputMatches(revalidated.input, admission.input)) {
    throw new TemplateError(
      "invalid_command",
      "This mandate changed since it was started, so nothing was created.",
    );
  }
}

async function complete(
  admin: SupabaseClient,
  actorId: string,
  admission: CreationAdmission,
): Promise<Gate0CreateReceipt> {
  const settled = await settledReceipt(admin, admission);
  if (settled) return settled;
  await assertSkillCapability(admission);

  const imports: ImportReceipt =
    admission.targets.length === 0
      ? { requestId: admission.requestId, projectId: admission.dealId, skills: [] }
      : await importTemplateSkills(admission.requestId, {
          companyId: admission.input.tenantId,
          revisionId: admission.revisionId,
          projectId: admission.dealId,
          targets: admission.targets,
        });

  return withTemplateErrors(() =>
    finalizeCreation(admin, actorId, admission.requestId, imports),
  );
}

async function settledReceipt(
  admin: SupabaseClient,
  admission: CreationAdmission,
): Promise<Gate0CreateReceipt | null> {
  if (admission.state !== "ready" || !admission.receipt) return null;
  await seedLeftOutSteps(admin, admission);
  return admission.receipt;
}

async function assertSkillCapability(
  admission: CreationAdmission,
): Promise<void> {
  if (admission.targets.length === 0) return;
  if (await isFlagEnabled("skill_authoring")) return;
  throw new TemplateError(
    "skill_unavailable",
    "Skills are not enabled here, so this rail was not used.",
  );
}

