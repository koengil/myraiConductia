import type { SupabaseClient } from "@supabase/supabase-js";

import type { ValidatedGate0Input } from "@/lib/deals/createDealInput";
import { TABLE } from "@/lib/constants/tables";
import { isRecord, isUuid } from "@/lib/skillPublication/parse";
import type { SkillBinding } from "@/lib/skillPublication/types";

import { leftOutCatalogSteps, materializeRail } from "./materialize";

import type {
  CreationAdmission,
  Gate0CreateReceipt,
  ImportReceipt,
  ImportTarget,
  RailManifest,
  TemplateSelection,
} from "./types";
import { dbFailure } from '@/lib/errors/upstream';

const CODENAME_CONSTRAINT = "deals_codename_unique_active";

function finalizeFailure(error: { code?: string; message: string }): Error {
  const taken =
    error.code === "23505" && error.message.includes(CODENAME_CONSTRAINT);
  if (taken) return new Error("codename_taken");
  return dbFailure("Rail template finalize creation", error);
}

function invalidResponse(): Error {
  return new Error("rail_template_response_invalid");
}

function targetsOf(value: unknown): ImportTarget[] {
  if (!Array.isArray(value)) throw invalidResponse();
  return value.map((target) => {
    if (
      !isRecord(target) ||
      typeof target.key !== "string" ||
      !isUuid(target.operationId) ||
      !isUuid(target.skillId) ||
      !isUuid(target.versionId)
    ) {
      throw invalidResponse();
    }
    return {
      key: target.key,
      operationId: target.operationId,
      skillId: target.skillId,
      versionId: target.versionId,
    };
  });
}

function stepIdsOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw invalidResponse();
  const ids: Record<string, string> = {};
  for (const [key, id] of Object.entries(value)) {
    if (!isUuid(id)) throw invalidResponse();
    ids[key] = id;
  }
  return ids;
}

export function receiptOf(value: unknown): Gate0CreateReceipt {
  if (
    !isRecord(value) ||
    !isRecord(value.deal) ||
    !isUuid(value.deal.id) ||
    typeof value.deal.code !== "string" ||
    !Array.isArray(value.notified) ||
    !isRecord(value.screening)
  ) {
    throw invalidResponse();
  }
  return {
    deal: { id: value.deal.id, code: value.deal.code },
    memberships: value.memberships ?? [],
    notified: value.notified as Gate0CreateReceipt["notified"],
    screening: value.screening as Gate0CreateReceipt["screening"],
  };
}

function admissionOf(value: unknown): CreationAdmission {
  if (
    !isRecord(value) ||
    !isUuid(value.requestId) ||
    !isUuid(value.actorId) ||
    !isUuid(value.companyId) ||
    !isUuid(value.dealId) ||
    !isUuid(value.revisionId) ||
    !isRecord(value.manifest) ||
    !isRecord(value.input) ||
    (value.state !== "preparing" && value.state !== "ready")
  ) {
    throw invalidResponse();
  }
  return {
    requestId: value.requestId,
    actorId: value.actorId,
    companyId: value.companyId,
    dealId: value.dealId,
    revisionId: value.revisionId,
    manifest: value.manifest as unknown as RailManifest,
    input: value.input as unknown as ValidatedGate0Input,
    stepIds: stepIdsOf(value.stepIds),
    targets: targetsOf(value.targets),
    state: value.state,
    receipt:
      value.receipt === null || value.receipt === undefined
        ? null
        : receiptOf(value.receipt),
  };
}

export async function admitCreation(
  admin: SupabaseClient,
  input: ValidatedGate0Input,
  selection: TemplateSelection,
  requestId: string,
): Promise<CreationAdmission> {
  const { data, error } = await admin.rpc("rail_template_admit_creation", {
    p_actor_id: input.actorId,
    p_request_id: requestId,
    p_selection: selection,
    p_input: input,
  });
  if (error) throw dbFailure('Rail template admit creation', error);
  return admissionOf(data);
}

export async function readCreation(
  admin: SupabaseClient,
  actorId: string,
  requestId: string,
): Promise<CreationAdmission | null> {
  if (!isUuid(requestId)) return null;
  const { data, error } = await admin
    .from(TABLE.RAIL_TEMPLATE_CREATIONS)
    .select(
      "request_id, actor_id, company_id, revision_id, reserved_deal_id, input, step_ids, targets, state, receipt",
    )
    .eq("request_id", requestId)
    .eq("actor_id", actorId)
    .maybeSingle();
  if (error) throw dbFailure('Rail template creation read', error);
  const row = data;
  if (!isRecord(row) || !isUuid(row.revision_id)) return null;

  const revision = await admin
    .from(TABLE.RAIL_TEMPLATE_REVISIONS)
    .select("id, template_id, manifest")
    .eq("id", row.revision_id)
    .maybeSingle();
  if (revision.error) throw dbFailure('Rail template revision read', revision.error);
  if (!isRecord(revision.data)) throw invalidResponse();

  return admissionOf({
    requestId: row.request_id,
    actorId: row.actor_id,
    companyId: row.company_id,
    dealId: row.reserved_deal_id,
    revisionId: row.revision_id,
    manifest: revision.data.manifest,
    input: row.input,
    stepIds: row.step_ids,
    targets: row.targets,
    state: row.state,
    receipt: row.receipt,
  });
}

export async function readCreationTemplateId(
  admin: SupabaseClient,
  revisionId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from(TABLE.RAIL_TEMPLATE_REVISIONS)
    .select("template_id")
    .eq("id", revisionId)
    .maybeSingle();
  if (error) throw dbFailure('Rail template read', error);
  return isRecord(data) && isUuid(data.template_id) ? data.template_id : null;
}

export async function finalizeCreation(
  admin: SupabaseClient,
  actorId: string,
  requestId: string,
  imports: ImportReceipt,
): Promise<Gate0CreateReceipt> {
  const admission = await readCreation(admin, actorId, requestId);
  if (admission === null) throw new Error("not_found");
  if (admission.state === "ready" && admission.receipt) {
    await seedLeftOutSteps(admin, admission);
    return admission.receipt;
  }
  if (imports.requestId !== requestId || imports.projectId !== admission.dealId) {
    throw new Error("provider_unavailable");
  }

  const bindings: Record<string, SkillBinding> = {};
  for (const skill of imports.skills) bindings[skill.key] = skill.binding;

  const { data, error } = await admin.rpc("rail_template_finalize_creation", {
    p_actor_id: actorId,
    p_request_id: requestId,
    p_imports: imports,
    p_seed: materializeRail(admission.manifest, admission.stepIds, bindings),
  });
  if (error) throw finalizeFailure(error);
  const receipt = receiptOf(data);
  await seedLeftOutSteps(admin, admission);
  return receipt;
}

export async function seedLeftOutSteps(
  admin: SupabaseClient,
  admission: CreationAdmission,
): Promise<void> {
  const left = leftOutCatalogSteps(admission.manifest, admission.stepIds);
  if (left.length === 0) return;
  const removedAt = new Date().toISOString();
  const { error } = await admin.from(TABLE.DEAL_STEPS).upsert(
    left.map((step) => ({
      deal_id: admission.dealId,
      step_id: step.stepId,
      seq: step.seq,
      status: "pending",
      census_version: admission.manifest.censusVersion,
      phase_index: step.phaseIndex,
      display_order: step.displayOrder,
      origin: "catalog",
      anchor_step_id: step.anchorId,
      removed_at: removedAt,
      template_step_key: step.stepId,
    })),
    { onConflict: "deal_id,step_id", ignoreDuplicates: true },
  );
  if (error) throw dbFailure('Rail step seed', error);
}
