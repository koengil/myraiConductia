export type MeetingType = 'first_call' | 'closing' | 'working_session';
export type BriefDepth = 'one_pager' | 'full_memo';

export type MdBriefingInputs = {
  meetingType: MeetingType;
  depth: BriefDepth;
  attendees?: string;
};

export type PresearchInputs = {
  meetingType: MeetingType;
  attendees?: string;
};

export type RunLifecycleStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PendingQuestion = {
  questionId: string;
  text: string;
  options: readonly string[] | null;
  blocking: boolean;
};

export type RunArtifactRef = {
  path: string;
  kind: 'document' | 'structured';
  primary: boolean;
  bytes: number;
};

export type RunFilingRef = {
  documentId: string;
  folder: string;
  documentType: string;
  title: string;
  filename: string | null;
  bytes: number | null;
  outcome: 'created' | 'version_added';
  version: number;
};

export type RunAccepted = {
  executionId: string;
  runId: string;
  agentName: string;
  status: RunLifecycleStatus;
  acceptedAt: string;
  links: {
    self: string;
    events: string;
    cancel: string;
    input: string;
  };
};

export type RunStatus = {
  executionId: string;
  runId: string;
  agentName: string;
  status: RunLifecycleStatus;
  outcome: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  dryRun: boolean;
  pendingQuestions: PendingQuestion[];
  artifacts: RunArtifactRef[];
  filings: RunFilingRef[];
  costUsd: number | null;
  /** Every model the run called, as catalog ids (`anthropic/claude-sonnet-5`); empty when not reported. */
  modelIds: string[];
  durationMs: number | null;
  error: { code: string; message: string } | null;
};

export type IgnatiousApiError = {
  code: string;
  message: string;
  retryable?: boolean;
};
