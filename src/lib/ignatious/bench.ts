import type { IgnatiousConfig } from './config';
import { IgnatiousRequestError } from './control-plane';
import {
  isBenchEffortLevel,
  isBenchModelAlias,
  isBenchTestStatus,
  type BenchEffortLevel,
  type BenchModelAlias,
  type BenchTestStatus,
  type ProcessTag,
} from './processTag';
import { readSkillPublicationServiceConfig } from '../skillPublication/config';
import { parseSkillInputFields, type SkillInputField, type SkillInputValues } from '../skillRun/inputs';
import { benchReference, type SkillReference } from '../skillRun/types';

export type BenchSkillTag = ProcessTag;

export type BenchSkill = {
  name: string;
  origin: 'repo' | 'upload';
  tag: BenchSkillTag | null;
  status: 'ok' | 'not_loadable';
  reason: string | null;
  description: string | null;
  version: number | null;
  model: BenchModelAlias | null;
  modelFrom: 'seed' | 'operator';
  maxModel: BenchModelAlias | null;
  maxEffort: BenchEffortLevel | null;
  routingFrom: 'seed' | 'operator';
  tester: string | null;
  testStatus: BenchTestStatus;
  enabled: boolean;
  sizeBytes: number | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type BenchDefaultModel = {
  modelId: string;
  alias: BenchModelAlias | null;
};

export type BenchSkillList = {
  skills: BenchSkill[];
  defaultModel: BenchDefaultModel | null;
};

export type BenchSkillVersion = {
  version: number;
  origin: 'repo' | 'upload';
  updatedAt: string;
  updatedBy: string | null;
  downloadable: boolean;
  current: boolean;
  description: string | null;
  status: 'ok' | 'not_loadable';
  reason: string | null;
  sha256: string | null;
  contentHash: string | null;
  bytesRetained: boolean;
  inputs: SkillInputField[];
};

export type BenchChatBody = {
  tenantId: string;
  leadId: string;
  message: string;
  conversationId?: string | null;
  selection?: BenchSkillTag | null;
  model?: BenchModelAlias | null;
  token: string;
};

export type BenchSkillRunBody = {
  runId: string;
  skill: SkillReference;
  projectId: string;
  inputs: SkillInputValues;
  instructions: string | null;
  tenantId: string;
  leadId: string;
  model?: string | null;
  token: string;
};

export type BenchRevisionPassage = { id: string; start: number; end: number; comment: string };

export type BenchSkillRunRevisionBody = {
  revisionId: string;
  skill: SkillReference | null;
  projectId: string;
  document: string;
  passages: BenchRevisionPassage[];
  tenantId: string;
  leadId: string;
  model?: string | null;
  token: string;
};

export type PublicationLineageEntry = {
  versionId: string;
  digest: string;
  publishedAt: string;
  inputs: SkillInputField[];
};

export async function listPublicationLineage(
  skillId: string,
  projectId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicationLineageEntry[]> {
  const config = readSkillPublicationServiceConfig();
  if (!config) {
    throw new IgnatiousRequestError(503, 'The skill save service is not configured.');
  }

  const url = `${config.benchUrl}/v1/conductia/skill-publications/skills/${encodeURIComponent(skillId)}/lineage?projectId=${encodeURIComponent(projectId)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${config.publicationToken}` },
    });
  } catch {
    throw new IgnatiousRequestError(
      503,
      `Skill save service unreachable at ${config.benchUrl}.`,
    );
  }
  if (!response.ok) {
    throw new IgnatiousRequestError(response.status, `Skill save service returned ${response.status}`);
  }
  return normalizeLineage(await response.json());
}

export function createSkillBench(config: IgnatiousConfig, fetchImpl: typeof fetch = fetch) {
  const headers = (extra?: HeadersInit): HeadersInit => ({
    'x-api-key': config.apiKey,
    ...extra,
  });

  async function benchFetch(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${config.benchUrl}${path}`, init);
    } catch {
      throw new IgnatiousRequestError(
        503,
        `Skill bench unreachable at ${config.benchUrl}. Locally start @ignatious/skill-bench; on deploy use the same host as IGNATIOUS_CONTROL_PLANE_URL.`,
      );
    }
  }

  return {
    async listSkills(): Promise<BenchSkillList> {
      const response = await benchFetch('/v1/bench/skills', { headers: headers() });
      if (!response.ok) {
        throw new IgnatiousRequestError(response.status, `Skill bench returned ${response.status}`);
      }
      return normalizeSkillList(await response.json());
    },

    async listVersions(name: string): Promise<{ current: number | null; versions: BenchSkillVersion[] }> {
      const response = await benchFetch(
        `/v1/bench/skills/${encodeURIComponent(name)}/versions`,
        { headers: headers() },
      );
      if (!response.ok) {
        throw new IgnatiousRequestError(response.status, `Skill bench returned ${response.status}`);
      }
      return normalizeVersionList(await response.json());
    },

    async chat(body: BenchChatBody, signal?: AbortSignal): Promise<Response> {
      return benchFetch('/v1/bench/chat', {
        method: 'POST',
        headers: headers({
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${body.token}`,
        }),
        body: JSON.stringify({
          tenantId: body.tenantId,
          leadId: body.leadId,
          message: body.message,
          conversationId: body.conversationId ?? null,
          selection: body.selection ?? null,
          model: body.model ?? null,
          ...(config.conductiaBaseUrl ? { conductiaBaseUrl: config.conductiaBaseUrl } : {}),
        }),
        signal,
      });
    },

    async startSkillRun(body: BenchSkillRunBody, signal?: AbortSignal): Promise<Response> {
      return benchFetch('/v1/bench/skill-runs', {
        method: 'POST',
        headers: headers({
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${body.token}`,
        }),
        body: JSON.stringify({
          runId: body.runId,
          skill: benchReference(body.skill, body.projectId),
          inputs: body.inputs,
          instructions: body.instructions,
          ...(body.instructions ? { input: body.instructions } : {}),
          tenantId: body.tenantId,
          leadId: body.leadId,
          model: body.model ?? null,
          ...(config.conductiaBaseUrl ? { conductiaBaseUrl: config.conductiaBaseUrl } : {}),
        }),
        signal,
      });
    },

    async startSkillRunRevision(
      body: BenchSkillRunRevisionBody,
      signal?: AbortSignal,
    ): Promise<Response> {
      return benchFetch('/v1/bench/skill-run-revisions', {
        method: 'POST',
        headers: headers({
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${body.token}`,
        }),
        body: JSON.stringify({
          revisionId: body.revisionId,
          skill: body.skill ? benchReference(body.skill, body.projectId) : null,
          document: body.document,
          passages: body.passages,
          tenantId: body.tenantId,
          leadId: body.leadId,
          model: body.model ?? null,
          ...(config.conductiaBaseUrl ? { conductiaBaseUrl: config.conductiaBaseUrl } : {}),
        }),
        signal,
      });
    },
  };
}

export function normalizeSkillList(body: unknown): BenchSkillList {
  const rec = isRecord(body) ? body : {};
  const rawSkills = Array.isArray(rec.skills) ? rec.skills : [];
  return {
    skills: rawSkills.filter(isRecord).map(normalizeSkill).filter((skill) => skill.name),
    defaultModel: normalizeDefaultModel(rec.defaultModel),
  };
}

export function normalizeSkill(raw: Record<string, unknown>): BenchSkill {
  const tag = normalizeTag(raw.tag);
  const origin: BenchSkill['origin'] =
    raw.origin === 'upload' || raw.source === 'staged' ? 'upload' : 'repo';
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    origin,
    tag,
    status: raw.status === 'not_loadable' ? 'not_loadable' : 'ok',
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    description: typeof raw.description === 'string' ? raw.description : null,
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : null,
    model: isBenchModelAlias(raw.model) ? raw.model : null,
    modelFrom: raw.modelFrom === 'operator' ? 'operator' : 'seed',
    maxModel: isBenchModelAlias(raw.maxModel) ? raw.maxModel : null,
    maxEffort: isBenchEffortLevel(raw.maxEffort) ? raw.maxEffort : null,
    routingFrom: raw.routingFrom === 'operator' ? 'operator' : 'seed',
    tester: typeof raw.tester === 'string' ? raw.tester : null,
    testStatus: isBenchTestStatus(raw.testStatus) ? raw.testStatus : 'untested',
    enabled: raw.enabled !== false,
    sizeBytes: typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
  };
}

export function isRunnableBenchSkill(skill: BenchSkill): boolean {
  return skill.enabled && skill.status === 'ok';
}

function normalizeTag(value: unknown): BenchSkillTag | null {
  if (!isRecord(value) || typeof value.stageId !== 'string') return null;
  return {
    stageId: value.stageId,
    applicationId: typeof value.applicationId === 'string' ? value.applicationId : null,
  };
}

function normalizeDefaultModel(value: unknown): BenchDefaultModel | null {
  if (!isRecord(value) || typeof value.modelId !== 'string') return null;
  return {
    modelId: value.modelId,
    alias: isBenchModelAlias(value.alias) ? value.alias : null,
  };
}

function normalizeVersionList(body: unknown): { current: number | null; versions: BenchSkillVersion[] } {
  const rec = isRecord(body) ? body : {};
  const raw = Array.isArray(rec.versions) ? rec.versions : [];
  return {
    current: typeof rec.current === 'number' ? rec.current : null,
    versions: raw.filter(isRecord).map(normalizeVersion).filter((row) => row.version > 0),
  };
}

function normalizeVersion(raw: Record<string, unknown>): BenchSkillVersion {
  return {
    version: typeof raw.version === 'number' ? raw.version : 0,
    origin: raw.origin === 'upload' ? 'upload' : 'repo',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
    downloadable: raw.downloadable === true,
    current: raw.current === true,
    description: typeof raw.description === 'string' ? raw.description : null,
    status: raw.status === 'not_loadable' ? 'not_loadable' : 'ok',
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    sha256: typeof raw.sha256 === 'string' ? raw.sha256 : null,
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
    bytesRetained: raw.bytesRetained !== false,
    inputs: parseSkillInputFields(raw.inputs),
  };
}

function normalizeLineage(body: unknown): PublicationLineageEntry[] {
  const rec = isRecord(body) ? body : {};
  const raw = Array.isArray(rec.lineage) ? rec.lineage : [];
  return raw
    .filter(isRecord)
    .map(normalizeLineageEntry)
    .filter((entry): entry is PublicationLineageEntry => entry !== null);
}

function normalizeLineageEntry(raw: Record<string, unknown>): PublicationLineageEntry | null {
  if (
    typeof raw.versionId !== 'string' ||
    typeof raw.digest !== 'string' ||
    typeof raw.publishedAt !== 'string'
  ) {
    return null;
  }
  return {
    versionId: raw.versionId,
    digest: raw.digest,
    publishedAt: raw.publishedAt,
    inputs: parseSkillInputFields(raw.inputs),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
