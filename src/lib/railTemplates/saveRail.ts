import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isFlagEnabled } from "@/lib/api/v1/requireFlag";
import { dbFailure } from "@/lib/errors/upstream";
import { PROTECTED_STEP_IDS } from "@/lib/rail/protectedSteps";
import { isRecord, isUuid } from "@/lib/skillPublication/parse";

import { requireTemplateSave, type TemplateSourceScope } from "./access";
import { retainTemplateSkills } from "./providerClient";
import {
  buildRailDraft,
  type DraftSourceStep,
  type RailDraft,
  type TargetStep,
} from "./railDraft";
import { readRailSource } from "./readSource";
import {
  TEMPLATE_ERROR_MESSAGE,
  TemplateError,
  withTemplateErrors,
  type RetainReceipt,
  type SaveRailCommand,
  type TemplateErrorCode,
  type TemplateSummary,
} from "./types";

type SaveCheck = { tenantId: string; target: TargetStep[] | null };

const SKILLS_OFF = "Skills are not enabled here, so this rail was not saved.";
const NO_RUNNABLE_SKILL = "A step on this rail has no runnable skill version.";

const DRAFT_FAILURES: Readonly<Record<string, string>> = {
  empty_rail: "This rail has no active steps to save.",
  unstructured_rail: "This rail is not on the project rail model yet.",
  invalid_step_order: "This rail has a step with no usable position.",
  duplicate_catalog_step: "This rail repeats a standard step.",
  duplicate_step_key: "This rail has two steps that came from the same template step.",
  missing_protected_step: "This rail is missing a required step.",
  unsupported_definition: "This rail has a step Conductia cannot save.",
  skill_step_description:
    "A skill step on this rail needs a description of 1 to 2,000 characters.",
  step_description_too_long:
    "A step on this rail has a description over 4,000 characters.",
};

const RAISED_STATE = /^P000[1-4]$/;

function saveFailure(
  step: string,
  error: { code?: string | null; message?: string | null },
): Error {
  const raised = typeof error.message === "string" ? error.message : "";
  if (
    RAISED_STATE.test(error.code ?? "") &&
    Object.hasOwn(TEMPLATE_ERROR_MESSAGE, raised)
  ) {
    const code = raised as TemplateErrorCode;
    return new TemplateError(code, TEMPLATE_ERROR_MESSAGE[code]);
  }
  return dbFailure(step, error);
}

function invalidResponse(): Error {
  return new Error("rail_template_response_invalid");
}

function targetStep(value: unknown): TargetStep {
  if (!isRecord(value) || typeof value.stepId !== "string") throw invalidResponse();
  return {
    stepId: value.stepId,
    skill: isRecord(value.skill) ? value.skill : null,
    retainedDigest:
      typeof value.retainedDigest === "string" ? value.retainedDigest : null,
  };
}

function summaryOf(value: unknown): TemplateSummary {
  if (
    !isRecord(value) ||
    !isUuid(value.id) ||
    !isUuid(value.revisionId) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.stepCount !== "number" ||
    typeof value.skillCount !== "number" ||
    typeof value.version !== "number" ||
    typeof value.updatedAt !== "string"
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    revisionId: value.revisionId,
    name: value.name,
    description: value.description,
    stepCount: value.stepCount,
    skillCount: value.skillCount,
    version: value.version,
    updatedAt: value.updatedAt,
  };
}

async function completedSave(
  admin: SupabaseClient,
  actorId: string,
  dealId: string,
  requestId: string,
): Promise<TemplateSummary | null> {
  const { data, error } = await admin.rpc("rail_catalog_save_replay", {
    p_actor_id: actorId,
    p_request_id: requestId,
    p_deal_id: dealId,
  });
  if (error) throw saveFailure("Rail template save replay", error);
  return data === null || data === undefined ? null : summaryOf(data);
}

async function checkSave(
  admin: SupabaseClient,
  actorId: string,
  scope: TemplateSourceScope,
  command: SaveRailCommand,
  sourceFingerprint: string,
): Promise<SaveCheck> {
  const { data, error } = await admin.rpc("rail_catalog_save_check", {
    p_actor_id: actorId,
    p_company_id: scope.companyId,
    p_deal_id: scope.dealId,
    p_target: command.target,
    p_source_fingerprint: sourceFingerprint,
  });
  if (error) throw saveFailure("Rail template save check", error);
  if (!isRecord(data) || !isUuid(data.tenantId)) throw invalidResponse();
  if (data.target === null) {
    if (command.target.kind === "replace") throw invalidResponse();
    return { tenantId: data.tenantId, target: null };
  }
  if (!isRecord(data.target) || !Array.isArray(data.target.steps)) {
    throw invalidResponse();
  }
  return { tenantId: data.tenantId, target: data.target.steps.map(targetStep) };
}

function draftOf(steps: DraftSourceStep[], target: TargetStep[] | null): RailDraft {
  try {
    return buildRailDraft(steps, target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "skill_unavailable") {
      throw new TemplateError("skill_unavailable", NO_RUNNABLE_SKILL);
    }
    const message = DRAFT_FAILURES[reason];
    if (message) throw new TemplateError("invalid_command", message);
    throw error;
  }
}

export async function saveRailToCatalog(
  admin: SupabaseClient,
  actorId: string,
  command: SaveRailCommand,
): Promise<TemplateSummary> {
  const scope = await requireTemplateSave(admin, actorId, command.sourceDealId);
  const completed = await withTemplateErrors(() =>
    completedSave(admin, actorId, scope.dealId, command.requestId),
  );
  if (completed !== null) return completed;
  const source = await withTemplateErrors(() =>
    readRailSource(admin, actorId, scope.dealId),
  );
  const check = await withTemplateErrors(() =>
    checkSave(admin, actorId, scope, command, source.sourceFingerprint),
  );
  const draft = draftOf(source.steps, check.target);

  let revisionId: string | null = null;
  let receipt: RetainReceipt | null = null;
  if (draft.skills.length > 0) {
    if (!(await isFlagEnabled("skill_authoring"))) {
      throw new TemplateError("skill_unavailable", SKILLS_OFF);
    }
    revisionId = randomUUID();
    receipt = await retainTemplateSkills(revisionId, {
      companyId: check.tenantId,
      skills: draft.skills,
    });
  }

  return withTemplateErrors(async () => {
    const { data, error } = await admin.rpc("save_rail_to_catalog", {
      p_actor_id: actorId,
      p_company_id: scope.companyId,
      p_deal_id: scope.dealId,
      p_request_id: command.requestId,
      p_target: command.target,
      p_description: command.description,
      p_steps: draft.steps,
      p_source_fingerprint: source.sourceFingerprint,
      p_protected_ids: [...PROTECTED_STEP_IDS],
      p_revision_id: revisionId,
      p_receipt: receipt,
    });
    if (error) throw saveFailure("Rail template save", error);
    return summaryOf(data);
  });
}
