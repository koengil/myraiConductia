import type { BenchDefaultModel, BenchSkill, BenchSkillVersion } from './bench';
import { MD_BRIEFING_STEP_ID } from './config';
import { IgnatiousClientError } from './failure';
import type { BenchModelAlias } from './processTag';
import { trimTwinChatHistory, type TwinChatTurn } from './twinChat';
import type { MdBriefingInputs, PresearchInputs, RunAccepted, RunStatus } from './types';

function stepPath(dealId: string): string {
  return `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${MD_BRIEFING_STEP_ID}/ignatious`;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new IgnatiousClientError(response.status, body.error ?? `Request failed (${response.status})`);
  }
  return body;
}

export async function startMdBriefing(dealId: string, inputs: MdBriefingInputs): Promise<RunAccepted> {
  const response = await fetch(stepPath(dealId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(inputs),
  });
  return readJson<RunAccepted>(response);
}

export async function pollMdBriefing(dealId: string, executionId: string): Promise<RunStatus> {
  const response = await fetch(
    `${stepPath(dealId)}?executionId=${encodeURIComponent(executionId)}`,
  );
  return readJson<RunStatus>(response);
}

/** The newest run the signed-in banker triggered on this step, or null
 *  when none was. A 404 also covers "deal not found" / "no skill wired": the
 *  resume is best-effort, so those read as "nothing to pick up" here. */
export async function latestMdBriefing(dealId: string): Promise<RunStatus | null> {
  const response = await fetch(`${stepPath(dealId)}?latest=1`);
  if (response.status === 404) return null;
  return readJson<RunStatus>(response);
}

export async function answerMdBriefing(
  dealId: string,
  executionId: string,
  answers: { questionId: string; answer: string }[],
): Promise<unknown> {
  const response = await fetch(`${stepPath(dealId)}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executionId, answers }),
  });
  return readJson(response);
}

export async function cancelMdBriefing(dealId: string, executionId: string): Promise<unknown> {
  const response = await fetch(
    `${stepPath(dealId)}?executionId=${encodeURIComponent(executionId)}`,
    { method: 'DELETE' },
  );
  return readJson(response);
}

/**
 * A run artifact is addressed by its index in the run's artifact list, never by
 * its file path: the URL carries ids and an integer, and the route resolves the
 * path server-side (#331). Still a plain GET, so an <a href> download works.
 */
export function artifactUrl(dealId: string, executionId: string, index: number): string {
  const query = new URLSearchParams({ executionId, artifact: String(index) });
  return `${stepPath(dealId)}/artifacts?${query.toString()}`;
}

function companyPresearchPath(companyId: string): string {
  return `/api/v1/companies/${encodeURIComponent(companyId)}/presearch`;
}

export async function startPresearch(
  companyId: string,
  inputs: PresearchInputs,
): Promise<RunAccepted> {
  const response = await fetch(companyPresearchPath(companyId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(inputs),
  });
  return readJson<RunAccepted>(response);
}

/** A presearch poll: the run, plus whether its memo was applied to the lead. */
export type PresearchPoll = RunStatus & {
  applied?: { peopleAdded: number; peopleSkipped?: number; alreadyApplied: boolean } | null;
  /** The run completed and another apply holds its memo; keep polling. */
  applying?: boolean;
  /** The apply failed: 'retrying' on the next poll, or 'terminal' after the last attempt. */
  applyFailed?: 'retrying' | 'terminal' | null;
};

export async function pollPresearch(companyId: string, executionId: string): Promise<PresearchPoll> {
  const response = await fetch(
    `${companyPresearchPath(companyId)}?executionId=${encodeURIComponent(executionId)}`,
  );
  return readJson(response);
}

export async function latestPresearch(companyId: string): Promise<{
  latest: {
    execution_id: string;
    memo_md: string | null;
    people_added: number;
    created_at: string;
    agent: string;
  } | null;
  /** A completed run newer than `latest` whose memo is not applied yet. */
  pending?: { execution_id: string } | null;
}> {
  const response = await fetch(companyPresearchPath(companyId));
  return readJson(response);
}

export async function answerPresearch(
  companyId: string,
  executionId: string,
  answers: { questionId: string; answer: string }[],
): Promise<unknown> {
  const response = await fetch(`${companyPresearchPath(companyId)}/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executionId, answers }),
  });
  return readJson(response);
}

export async function cancelPresearch(companyId: string, executionId: string): Promise<unknown> {
  const response = await fetch(
    `${companyPresearchPath(companyId)}?executionId=${encodeURIComponent(executionId)}`,
    { method: 'DELETE' },
  );
  return readJson(response);
}

export function presearchArtifactUrl(companyId: string, executionId: string, index: number): string {
  const query = new URLSearchParams({ executionId, artifact: String(index) });
  return `${companyPresearchPath(companyId)}/artifacts?${query.toString()}`;
}

export async function startDebrief(
  companyId: string,
  input: { title?: string; text: string; runTwins?: boolean },
): Promise<{ documentId: string; sourceRun: RunAccepted; twinRun: RunAccepted | null }> {
  const response = await fetch(`/api/v1/companies/${encodeURIComponent(companyId)}/debrief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson(response);
}

export async function pollCompanyRun(companyId: string, executionId: string): Promise<RunStatus> {
  const response = await fetch(
    `/api/v1/companies/${encodeURIComponent(companyId)}/runs?executionId=${encodeURIComponent(executionId)}`,
  );
  return readJson(response);
}

export async function answerCompanyRun(
  companyId: string,
  executionId: string,
  answers: { questionId: string; answer: string }[],
): Promise<unknown> {
  const response = await fetch(`/api/v1/companies/${encodeURIComponent(companyId)}/runs/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executionId, answers }),
  });
  return readJson(response);
}

export async function cancelCompanyRun(companyId: string, executionId: string): Promise<unknown> {
  const response = await fetch(
    `/api/v1/companies/${encodeURIComponent(companyId)}/runs?executionId=${encodeURIComponent(executionId)}`,
    { method: 'DELETE' },
  );
  return readJson(response);
}

export async function listLeadTwins(companyId: string): Promise<{
  personas: { personaId: string; name: string; title: string; organization: string }[];
}> {
  const response = await fetch(`/api/v1/companies/${encodeURIComponent(companyId)}/twins`);
  return readJson(response);
}

export type { BenchDefaultModel, BenchSkill, BenchSkillVersion } from './bench';
export type { BenchModelAlias, ProcessTag } from './processTag';

export type BenchChatRequest = {
  message: string;
  conversationId?: string | null;
  selection?: { stageId: string; applicationId?: string | null } | null;
  model?: BenchModelAlias | null;
  /** The rail step the turn runs from; only used to attribute the AI spend. */
  stepId?: string | null;
};

export async function listBenchSkills(companyId?: string): Promise<{
  skills: BenchSkill[];
  defaultModel: BenchDefaultModel | null;
}> {
  const path = companyId
    ? `/api/v1/companies/${encodeURIComponent(companyId)}/bench/skills`
    : '/api/v1/bench/skills';
  const response = await fetch(path);
  return readJson(response);
}

export async function listDealBenchSkills(dealId: string): Promise<{
  skills: BenchSkill[];
  defaultModel: BenchDefaultModel | null;
}> {
  const response = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}/bench/skills`);
  return readJson(response);
}

export async function listBenchSkillVersions(
  name: string,
): Promise<{ current: number | null; versions: BenchSkillVersion[] }> {
  const response = await fetch(`/api/v1/bench/skills/${encodeURIComponent(name)}/versions`);
  return readJson(response);
}

async function postBenchChat(
  path: string,
  body: BenchChatRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new IgnatiousClientError(
      response.status,
      payload.error ?? `Skill bench failed (${response.status})`,
    );
  }
  return response;
}

export async function startBenchChat(companyId: string, body: BenchChatRequest): Promise<Response> {
  return postBenchChat(`/api/v1/companies/${encodeURIComponent(companyId)}/bench/chat`, body);
}

export async function startDealBenchChat(
  dealId: string,
  body: BenchChatRequest,
  signal?: AbortSignal,
): Promise<Response> {
  return postBenchChat(`/api/v1/deals/${encodeURIComponent(dealId)}/bench/chat`, body, signal);
}

export async function* readBenchEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n\n');
    while (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) {
        const data = dataLine.slice(6);
        if (data && data !== '{}') {
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch {
            // skip a malformed frame
          }
        }
      }
      idx = buffer.indexOf('\n\n');
    }
  }
}

export async function chatLeadTwin(
  companyId: string,
  personaId: string,
  message: string,
  history: TwinChatTurn[],
): Promise<{ reply: string }> {
  const response = await fetch(
    `/api/v1/companies/${encodeURIComponent(companyId)}/twins/${encodeURIComponent(personaId)}/chat`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The route caps replayed history; send the most recent turns that fit.
      body: JSON.stringify({ message, history: trimTwinChatHistory(history) }),
    },
  );
  return readJson(response);
}
