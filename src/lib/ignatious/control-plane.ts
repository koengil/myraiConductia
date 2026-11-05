import type { IgnatiousConfig } from './config';
import { MD_BRIEFING_AGENT, PRESEARCH_AGENT } from './config';
import type {
  BriefDepth,
  IgnatiousApiError,
  MeetingType,
  MdBriefingInputs,
  PresearchInputs,
  RunAccepted,
  RunLifecycleStatus,
  RunStatus,
} from './types';

export class IgnatiousRequestError extends Error {
  readonly status: number;
  readonly body: IgnatiousApiError | null;

  constructor(status: number, message: string, body: IgnatiousApiError | null = null) {
    super(message);
    this.name = 'IgnatiousRequestError';
    this.status = status;
    this.body = body;
  }
}

export type TriggerSkillParams = {
  agentName: string;
  tenantId: string;
  leadId: string;
  token: string;
  requestedBy: { userId: string; displayName: string | null };
  inputs?: Record<string, string>;
  idempotencyKey: string;
  triggerType?: 'skill_invoked' | 'document_uploaded';
  documentId?: string | null;
};

export type TriggerMdBriefingParams = Omit<TriggerSkillParams, 'agentName' | 'inputs'> & {
  inputs: MdBriefingInputs;
};

export type TriggerPresearchParams = Omit<TriggerSkillParams, 'agentName' | 'inputs'> & {
  inputs: PresearchInputs;
};

export type ControlPlaneFetch = typeof fetch;

export function createControlPlane(config: IgnatiousConfig, fetchImpl: ControlPlaneFetch = fetch) {
  const headers = (): HeadersInit => ({
    'x-api-key': config.apiKey,
    'content-type': 'application/json',
  });

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        headers: { ...headers(), ...init?.headers },
      });
    } catch {
      throw new IgnatiousRequestError(503, 'Ignatious control plane unreachable');
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const err = readApiError(parsed);
      throw new IgnatiousRequestError(
        response.status,
        err?.message ?? `Ignatious returned ${response.status}`,
        err,
      );
    }

    return parsed as T;
  }

  return {
    async triggerSkill(params: TriggerSkillParams): Promise<RunAccepted> {
      return request<RunAccepted>(`/v1/agents/${params.agentName}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: params.tenantId,
          leadId: params.leadId,
          triggerType: params.triggerType ?? 'skill_invoked',
          documentId: params.documentId ?? null,
          requestedBy: params.requestedBy,
          inputs: params.inputs ?? {},
          token: params.token,
          idempotencyKey: params.idempotencyKey,
          ...(config.conductiaBaseUrl ? { conductiaBaseUrl: config.conductiaBaseUrl } : {}),
        }),
      });
    },

    async postTwinMessage(params: {
      tenantId: string;
      leadId: string;
      personaId: string;
      message: string;
      token: string;
      history?: { role: 'user' | 'assistant'; content: string }[];
    }): Promise<{ reply: string; modelId?: string; costUsd?: number | null }> {
      return request(`/v1/agents/digital-twin/messages`, {
        method: 'POST',
        body: JSON.stringify({
          tenantId: params.tenantId,
          leadId: params.leadId,
          personaId: params.personaId,
          message: params.message,
          history: params.history ?? [],
          token: params.token,
        }),
      });
    },

    async triggerMdBriefing(params: TriggerMdBriefingParams): Promise<RunAccepted> {
      return this.triggerSkill({
        ...params,
        agentName: MD_BRIEFING_AGENT,
        inputs: compactMdBriefingInputs(params.inputs),
      });
    },

    async triggerPresearch(params: TriggerPresearchParams): Promise<RunAccepted> {
      return this.triggerSkill({
        ...params,
        agentName: PRESEARCH_AGENT,
        inputs: compactPresearchInputs(params.inputs),
      });
    },

    async getRun(executionId: string, includeOutput = false): Promise<RunStatus> {
      const suffix = includeOutput ? '?include=output' : '';
      const body = await request<unknown>(
        `/v1/runs/${encodeURIComponent(executionId)}${suffix}`,
      );
      return unwrapRunStatus(body);
    },

    async answerRun(
      executionId: string,
      body: {
        userId: string;
        displayName?: string | null;
        answers: { questionId: string; answer: string }[];
        timedOut?: boolean;
      },
    ): Promise<{ executionId: string; status: RunLifecycleStatus; answersAccepted: number }> {
      return request(`/v1/runs/${encodeURIComponent(executionId)}/input`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },

    async cancelRun(executionId: string): Promise<{ executionId: string; status: RunLifecycleStatus }> {
      return request(`/v1/runs/${encodeURIComponent(executionId)}/cancel`, {
        method: 'POST',
      });
    },

    async getArtifact(executionId: string, artifactPath: string): Promise<Response> {
      const encoded = artifactPath
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      let response: Response;
      try {
        response = await fetchImpl(
          `${config.baseUrl}/v1/runs/${encodeURIComponent(executionId)}/artifacts/${encoded}`,
          { headers: { 'x-api-key': config.apiKey } },
        );
      } catch {
        throw new IgnatiousRequestError(503, 'Ignatious control plane unreachable');
      }
      if (!response.ok) {
        throw new IgnatiousRequestError(response.status, `Artifact fetch failed (${response.status})`);
      }
      return response;
    },
  };
}

/**
 * GET /v1/runs/{id} answers `{ run: RunSummary }`, not the summary itself.
 * Treat a bare summary as a fallback so tests and older mocks still work.
 */
function unwrapRunStatus(body: unknown): RunStatus {
  if (!body || typeof body !== 'object') {
    throw new IgnatiousRequestError(502, 'Ignatious run status was empty');
  }
  const wrapped = (body as { run?: unknown }).run;
  const summary = (wrapped && typeof wrapped === 'object' ? wrapped : body) as Partial<RunStatus>;
  if (typeof summary.executionId !== 'string' || typeof summary.status !== 'string') {
    throw new IgnatiousRequestError(502, 'Ignatious run status was missing executionId or status');
  }
  return {
    executionId: summary.executionId,
    runId: typeof summary.runId === 'string' ? summary.runId : summary.executionId,
    agentName: typeof summary.agentName === 'string' ? summary.agentName : 'md-briefing',
    status: summary.status,
    outcome: summary.outcome ?? null,
    startedAt: summary.startedAt ?? null,
    finishedAt: summary.finishedAt ?? null,
    dryRun: summary.dryRun === true,
    pendingQuestions: Array.isArray(summary.pendingQuestions) ? summary.pendingQuestions : [],
    artifacts: Array.isArray(summary.artifacts) ? summary.artifacts : [],
    filings: Array.isArray(summary.filings) ? summary.filings : [],
    costUsd: typeof summary.costUsd === 'number' ? summary.costUsd : null,
    modelIds: Array.isArray(summary.modelIds)
      ? summary.modelIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : [],
    durationMs: typeof summary.durationMs === 'number' ? summary.durationMs : null,
    error:
      summary.error && typeof summary.error.message === 'string'
        ? { code: summary.error.code, message: summary.error.message }
        : null,
  };
}

function compactMdBriefingInputs(inputs: MdBriefingInputs): Record<string, string> {
  const out: Record<string, string> = {
    meetingType: inputs.meetingType,
    depth: inputs.depth,
  };
  const attendees = inputs.attendees?.trim();
  if (attendees) out.attendees = attendees;
  return out;
}

function compactPresearchInputs(inputs: PresearchInputs): Record<string, string> {
  const out: Record<string, string> = { meetingType: inputs.meetingType };
  const attendees = inputs.attendees?.trim();
  if (attendees) out.attendees = attendees;
  return out;
}

function readApiError(parsed: unknown): IgnatiousApiError | null {
  if (!parsed || typeof parsed !== 'object' || !('error' in parsed)) return null;
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const rec = error as { code?: unknown; message?: unknown; retryable?: unknown };
  if (typeof rec.code !== 'string' || typeof rec.message !== 'string') return null;
  return {
    code: rec.code,
    message: rec.message,
    retryable: rec.retryable === true,
  };
}

export function isMeetingType(value: unknown): value is MeetingType {
  return value === 'first_call' || value === 'closing' || value === 'working_session';
}

export function isBriefDepth(value: unknown): value is BriefDepth {
  return value === 'one_pager' || value === 'full_memo';
}
