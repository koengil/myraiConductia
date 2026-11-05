import type { PublicationRead } from "@/lib/skillPublication/types";
import type { SkillInputField } from "@/lib/skillRun/inputs";

export const DRAFT_STATUS = ["active", "archived", "published"] as const;
export type DraftStatus = (typeof DRAFT_STATUS)[number];

export const ATTEMPT_STATUS = ["running", "succeeded", "failed"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUS)[number];

export type Placement =
  | { kind: "phase_start"; phaseIndex: number }
  | { kind: "phase_end"; phaseIndex: number }
  | { kind: "after"; phaseIndex: number; afterStepId: string };

export type DraftPatch = {
  expectedEditRevision: number;
  name: string;
  placement: Placement | null;
  composerText: string;
};

export type MessageCommand = {
  clientMessageId: string;
  expectedEditRevision: number;
  text: string;
};

export type RetryCommand = { retryRequestId: string };
export type DiscardCommand = { expectedEditRevision: number };

export type CandidatePreview = {
  id: string;
  digest: string;
  schemaVersion: 1;
  name: string;
  purpose: string;
  expectedInput: string;
  expectedOutput: string;
  inputs: SkillInputField[];
};

export type AttemptRead = {
  id: string;
  messageId: string;
  number: number;
  status: AttemptStatus;
  responseText: string;
  error: { code: string; message: string } | null;
};

export type DraftRead = {
  id: string;
  dealId: string;
  status: DraftStatus;
  name: string;
  placement: Placement | null;
  composerText: string;
  editRevision: number;
  messages: Array<{
    id: string;
    ordinal: number;
    text: string;
    attempts: AttemptRead[];
  }>;
  activeAttempt: AttemptRead | null;
  candidate: CandidatePreview | null;
  publication: { available: false } | PublicationRead;
};
