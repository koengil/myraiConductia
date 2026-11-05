import type { SkillInputValues } from "./inputs";

export type RunOutcome = "succeeded" | "failed";

export type SkillReference =
  | { kind: "publication"; skillId: string; versionId: string; digest: string }
  | { kind: "mount"; name: string; version: number; digest: string };

export type BenchSkillReference =
  | (Extract<SkillReference, { kind: "publication" }> & { projectId: string })
  | Extract<SkillReference, { kind: "mount" }>;

export function benchReference(
  reference: SkillReference,
  projectId: string,
): BenchSkillReference {
  return reference.kind === "publication" ? { ...reference, projectId } : reference;
}

export type BoundStep = {
  dealStepId: string;
  stepId: string;
  title: string;
  binding: SkillReference;
};

export type StepResolutionFailure = {
  ok: false;
  code: "not_found" | "removed" | "not_skill_backed";
};

export type BindingResolution =
  | { ok: true; step: BoundStep }
  | StepResolutionFailure;

export type RunRecordBody = {
  runId: string;
  outcome: RunOutcome;
  resultText: string | null;
  errorMessage: string | null;
  providerRunId: string | null;
  startedAt: string | null;
  reference: SkillReference | null;
  model: string | null;
  clampedFrom: string | null;
  inputs: SkillInputValues;
  instructions: string | null;
};

export type SkillRunDocument = {
  id: string;
  name: string;
  folder: string | null;
  createdAt: string;
};

export type SkillRunSummary = {
  id: string;
  outcome: RunOutcome;
  actorName: string;
  input: string | null;
  inputs: SkillInputValues;
  resultText: string | null;
  errorMessage: string | null;
  costUsd: number | null;
  startedAt: string | null;
  createdAt: string;
  binding: SkillReference | null;
  model: string | null;
  clampedFrom: string | null;
  documents: SkillRunDocument[];
  headId: string;
  headText: string | null;
  revisions: RevisionSummary[];
};

export const REVISION_LIMITS = { edits: 20, comment: 2_000, text: 200_000 } as const;

export type EditKind = "comment" | "hand";

export type EditStatus = "applied" | "unresolved" | "failed";

export type EditRequest =
  | { kind: "comment"; start: number; end: number; comment: string; teach?: true }
  | { kind: "hand"; start: number; end: number; text: string };

export type EditRecord = {
  id: string;
  kind: EditKind;
  start: number;
  end: number;
  comment?: string;
  teach?: true;
  status: EditStatus;
  reason?: string;
  resultStart?: number;
  resultEnd?: number;
};

export type RevisionInputs =
  | { kind: "edits"; edits: EditRecord[]; skillMounted?: boolean }
  | { kind: "restore"; restoredFrom: string };

export type RevisionEditSummary = {
  id: string;
  kind: EditKind;
  start: number;
  end: number;
  comment: string | null;
  status: EditStatus;
  reason: string | null;
  teach: boolean;
  sent: boolean;
  resultStart: number | null;
  resultEnd: number | null;
  before: string | null;
};

export type RevisionSummary = {
  id: string;
  parentId: string;
  kind: "edits" | "restore";
  outcome: RunOutcome;
  errorMessage: string | null;
  actorName: string;
  createdAt: string;
  version: number | null;
  edits: RevisionEditSummary[];
  restoredFrom: string | null;
  skillMounted: boolean | null;
};
