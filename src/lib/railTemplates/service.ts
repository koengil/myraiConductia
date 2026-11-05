import type { SupabaseClient } from "@supabase/supabase-js";

import { TABLE } from "@/lib/constants/tables";
import { DEAL_RAIL, MVP_DEAL_RAIL, orderedSteps } from "@/lib/rail/dealRail";
import { isRecord, isUuid } from "@/lib/skillPublication/parse";

import {
  TemplateError,
  TEMPLATE_DESCRIPTION_LIMIT,
  TEMPLATE_NAME_LIMIT,
  type RailManifest,
  type SaveRailCommand,
  type TemplatePreview,
  type TemplateSummary,
} from "./types";
import { dbFailure } from '@/lib/errors/upstream';

const CUSTOM_STEP_TITLE = "Custom step";

const CENSUS_TITLES = new Map<string, string>([
  ...orderedSteps(DEAL_RAIL).map(
    (step) => [step.id, step.title] as [string, string],
  ),
  ...orderedSteps(MVP_DEAL_RAIL).map(
    (step) => [step.id, step.title] as [string, string],
  ),
]);

export function parseSaveRailCommand(value: unknown): SaveRailCommand {
  if (!isRecord(value) || !isUuid(value.requestId)) {
    throw invalid("This save command is not usable.");
  }
  const sourceDealId =
    typeof value.sourceDealId === "string" ? value.sourceDealId.trim() : "";
  if (sourceDealId === "") {
    throw invalid("This save command names no deal.");
  }
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  if (description.length > TEMPLATE_DESCRIPTION_LIMIT) {
    throw invalid("That description is too long.");
  }

  const target = value.target;
  if (!isRecord(target)) throw invalid("This save command has no target.");

  if (target.kind === "new") {
    const name = displayName(target.name);
    if (name.length < 1 || name.length > TEMPLATE_NAME_LIMIT) {
      throw invalid("A saved rail needs a name of 1 to 80 characters.");
    }
    if (name.toLowerCase() === "default") {
      throw invalid("A saved rail cannot be named Default.");
    }
    return {
      requestId: value.requestId,
      sourceDealId,
      description,
      target: { kind: "new", name },
    };
  }

  if (
    target.kind === "replace" &&
    isUuid(target.templateId) &&
    isUuid(target.expectedRevisionId)
  ) {
    return {
      requestId: value.requestId,
      sourceDealId,
      description,
      target: {
        kind: "replace",
        templateId: target.templateId,
        expectedRevisionId: target.expectedRevisionId,
      },
    };
  }

  throw invalid("This save command has no usable target.");
}

export async function listRailTemplates(
  admin: SupabaseClient,
  companyId: string,
): Promise<TemplateSummary[]> {
  const rows = await currentTemplates(admin, companyId);
  const revisions = await readRevisions(
    admin,
    rows.map((row) => row.revisionId),
  );
  return rows.flatMap((row) => {
    const revision = revisions.get(row.revisionId);
    return revision ? [summaryOf(row, revision)] : [];
  });
}

export async function listReplaceableTemplates(
  admin: SupabaseClient,
  companyId: string,
): Promise<TemplateSummary[]> {
  const { data, error } = await admin
    .from(TABLE.RAIL_CATALOG_TEMPLATES)
    .select("rail_template_id")
    .eq("company_id", companyId)
    .is("deleted_at", null);
  if (error) throw dbFailure("Rail catalog link read", error);

  const linked = new Set(
    (Array.isArray(data) ? data : []).flatMap((row) =>
      isRecord(row) && isUuid(row.rail_template_id) ? [row.rail_template_id] : [],
    ),
  );
  return (await listRailTemplates(admin, companyId)).filter((template) =>
    linked.has(template.id),
  );
}

export async function previewRailTemplate(
  admin: SupabaseClient,
  companyId: string,
  templateId: string,
): Promise<TemplatePreview | null> {
  if (!isUuid(templateId)) return null;
  const rows = await currentTemplates(admin, companyId, templateId);
  const row = rows[0];
  if (!row) return null;
  const revision = (await readRevisions(admin, [row.revisionId])).get(
    row.revisionId,
  );
  if (!revision) return null;
  return {
    ...summaryOf(row, revision),
    steps: revision.manifest.steps.map((step) => ({
      title: titleOf(step),
      phaseIndex: step.phaseIndex,
      displayOrder: step.displayOrder,
    })),
  };
}

function invalid(message: string): TemplateError {
  return new TemplateError("invalid_command", message);
}

function displayName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

type TemplateRow = { id: string; name: string; revisionId: string };

type RevisionRow = {
  id: string;
  description: string;
  manifest: RailManifest;
  createdAt: string;
};

async function currentTemplates(
  admin: SupabaseClient,
  companyId: string,
  templateId?: string,
): Promise<TemplateRow[]> {
  let query = admin
    .from(TABLE.RAIL_TEMPLATES)
    .select("id, name, current_revision_id, normalized_name")
    .eq("company_id", companyId)
    .not("current_revision_id", "is", null);
  if (templateId) query = query.eq("id", templateId);

  const { data, error } = await query.order("normalized_name", {
    ascending: true,
  });
  if (error) throw dbFailure('Rail template list', error);

  return (Array.isArray(data) ? data : []).flatMap((raw) => {
    if (
      !isRecord(raw) ||
      !isUuid(raw.id) ||
      typeof raw.name !== "string" ||
      !isUuid(raw.current_revision_id)
    ) {
      return [];
    }
    return [{ id: raw.id, name: raw.name, revisionId: raw.current_revision_id }];
  });
}

async function readRevisions(
  admin: SupabaseClient,
  revisionIds: string[],
): Promise<Map<string, RevisionRow>> {
  if (revisionIds.length === 0) return new Map();
  const { data, error } = await admin
    .from(TABLE.RAIL_TEMPLATE_REVISIONS)
    .select("id, description, manifest, created_at")
    .in("id", revisionIds);
  if (error) throw dbFailure('Rail template revisions read', error);

  const rows = new Map<string, RevisionRow>();
  for (const raw of Array.isArray(data) ? data : []) {
    if (
      !isRecord(raw) ||
      !isUuid(raw.id) ||
      typeof raw.description !== "string" ||
      typeof raw.created_at !== "string"
    ) {
      continue;
    }
    rows.set(raw.id, {
      id: raw.id,
      description: raw.description,
      manifest: parseManifest(raw.manifest),
      createdAt: new Date(raw.created_at).toISOString(),
    });
  }
  return rows;
}

function parseManifest(value: unknown): RailManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    typeof value.censusVersion !== "string" ||
    !Array.isArray(value.steps) ||
    !Array.isArray(value.skills) ||
    value.steps.some(
      (step) =>
        !isRecord(step) ||
        typeof step.phaseIndex !== "number" ||
        typeof step.displayOrder !== "number" ||
        typeof step.templateStepKey !== "string" ||
        step.templateStepKey === "",
    )
  ) {
    throw new TemplateError(
      "invalid_command",
      "This saved rail was written in a format Conductia cannot read.",
    );
  }
  return value as unknown as RailManifest;
}

function summaryOf(row: TemplateRow, revision: RevisionRow): TemplateSummary {
  return {
    id: row.id,
    revisionId: revision.id,
    name: row.name,
    description: revision.description,
    stepCount: revision.manifest.steps.length,
    skillCount: revision.manifest.skills.length,
    updatedAt: revision.createdAt,
  };
}

function titleOf(step: RailManifest["steps"][number]): string {
  if (step.catalogStepId !== null) {
    return CENSUS_TITLES.get(step.catalogStepId) ?? step.catalogStepId;
  }
  return step.definition?.title ?? CUSTOM_STEP_TITLE;
}
