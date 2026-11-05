import type { ManualStepDefinition } from "@/lib/rail/projectRail";
import type { ValidatedGate0Input } from "@/lib/deals/createDealInput";
import { DbError } from "@/lib/errors/upstream";
import type { SkillReference } from "@/lib/skillRun/types";
import type {
  CapabilityContract,
  SkillBinding,
  SkillStepDefinitionV1,
} from "@/lib/skillPublication/types";

export type TemplateDefinition =
  | { title: string; description: string }
  | Omit<SkillStepDefinitionV1, "skillBinding">;

export type TemplateSkill = {
  key: string;
  source: SkillReference;
  name: string;
  contract: CapabilityContract;
};

export type CandidateSkillSource = {
  kind: "candidate";
  candidateId: string;
  digest: string;
};

export type TemplateSkillSource = SkillReference | CandidateSkillSource;

export type ManifestSkill = Omit<TemplateSkill, "source"> & {
  source: TemplateSkillSource;
};

export type TemplateStep = {
  key: string;
  templateStepKey: string;
  catalogStepId: string | null;
  seq: number | null;
  phaseIndex: number;
  displayOrder: number;
  definition: TemplateDefinition | null;
  skillKey: string | null;
};

export type RailManifest = {
  schemaVersion: 2;
  censusVersion: string;
  steps: TemplateStep[];
  skills: ManifestSkill[];
};

export type SeededTemplateStep = {
  id: string;
  stepId: string;
  seq: number | null;
  origin: "catalog" | "custom";
  phaseIndex: number;
  displayOrder: number;
  definition: ManualStepDefinition | SkillStepDefinitionV1 | null;
  binding: SkillBinding | null;
};

export type LeftOutCatalogStep = {
  stepId: string;
  seq: number;
  phaseIndex: number;
  displayOrder: number;
  anchorId: string | null;
};

export type SaveRailCommand = {
  requestId: string;
  sourceDealId: string;
  description: string;
  target:
    | { kind: "new"; name: string }
    | { kind: "replace"; templateId: string; expectedRevisionId: string };
};

export type TemplateSummary = {
  id: string;
  revisionId: string;
  name: string;
  description: string;
  stepCount: number;
  skillCount: number;
  updatedAt: string;
  version?: number;
};

export type TemplatePreview = TemplateSummary & {
  steps: Array<{ title: string; phaseIndex: number; displayOrder: number }>;
};

export type RetainRequest = {
  companyId: string;
  sourceProjectId?: string;
  skills: Array<{ key: string; source: TemplateSkillSource }>;
};

export type RetainReceipt = {
  revisionId: string;
  assets: Array<{ key: string; packageDigest: string }>;
};

export type ImportTarget = {
  key: string;
  operationId: string;
  skillId: string;
  versionId: string;
};

export type ImportRequest = {
  companyId: string;
  revisionId: string;
  projectId: string;
  targets: ImportTarget[];
};

export type ImportReceipt = {
  requestId: string;
  projectId: string;
  skills: Array<{ key: string; binding: SkillBinding }>;
};

export type TemplateSelection = { templateId: string; revisionId: string };

export type TemplateErrorCode =
  | "name_taken"
  | "stale_template"
  | "source_changed"
  | "idempotency_conflict"
  | "codename_taken"
  | "skill_unavailable"
  | "provider_unavailable"
  | "not_found"
  | "forbidden"
  | "invalid_command"
  | "unpublished_changes"
  | "order_differs"
  | "nothing_to_publish";

export const TEMPLATE_NAME_LIMIT = 80;
export const TEMPLATE_DESCRIPTION_LIMIT = 500;

export const TEMPLATE_ERROR_STATUS: Readonly<
  Record<TemplateErrorCode, number>
> = {
  name_taken: 409,
  stale_template: 409,
  source_changed: 409,
  idempotency_conflict: 409,
  codename_taken: 409,
  skill_unavailable: 409,
  provider_unavailable: 503,
  not_found: 404,
  forbidden: 403,
  invalid_command: 422,
  unpublished_changes: 409,
  order_differs: 409,
  nothing_to_publish: 409,
};

export const TEMPLATE_ERROR_MESSAGE: Readonly<
  Record<TemplateErrorCode, string>
> = {
  name_taken: "Another saved rail in your company already uses that name.",
  stale_template: "That saved rail changed while you were working.",
  source_changed: "This rail changed while it was being saved.",
  idempotency_conflict:
    "That save was already started with different details.",
  codename_taken:
    "That code name is already in use on a live deal. Pick another.",
  skill_unavailable: "A skill on this rail is no longer available to copy.",
  provider_unavailable: "Skill retention did not complete, so nothing changed.",
  not_found: "That saved rail is not available.",
  forbidden: "This company rail is not available to you.",
  invalid_command: "This save command is not usable.",
  unpublished_changes:
    "This template has changes that are not published. Publish or undo them on Rail templates first.",
  order_differs:
    "This rail orders its steps differently from that template. Save it as a new template instead.",
  nothing_to_publish: "This template already matches this rail.",
};

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: TemplateErrorCode,
    message: string,
    status: number = TEMPLATE_ERROR_STATUS[code],
  ) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
    this.status = status;
    this.retryable = code === "provider_unavailable";
  }
}

export type Gate0CreateReceipt = {
  deal: { id: string; code: string };
  memberships: unknown;
  notified: Array<{ userId: string; at: string }>;
  screening: ValidatedGate0Input["screening"];
};

export type CreationAdmission = {
  requestId: string;
  actorId: string;
  companyId: string;
  dealId: string;
  revisionId: string;
  manifest: RailManifest;
  input: ValidatedGate0Input;
  stepIds: Record<string, string>;
  targets: ImportTarget[];
  state: "preparing" | "ready";
  receipt: Gate0CreateReceipt | null;
};

export type CreationResumeView = {
  requestId: string;
  input: ValidatedGate0Input;
  selection: TemplateSelection;
  state: "preparing" | "ready";
};

export async function withTemplateErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    // A SQL function raises the code as its message; the repositories carry it as a DbError's code.
    const raised = error instanceof DbError ? (error.code ?? "") : error instanceof Error ? error.message : "";
    if (Object.hasOwn(TEMPLATE_ERROR_MESSAGE, raised)) {
      const code = raised as TemplateErrorCode;
      throw new TemplateError(code, TEMPLATE_ERROR_MESSAGE[code]);
    }
    throw error;
  }
}
