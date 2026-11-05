import {
  readSkillPublicationServiceConfig,
  SKILL_PUBLICATION_REQUEST_TIMEOUT_MS,
} from "@/lib/skillPublication/config";
import {
  hasExactKeys,
  isDigest,
  isNonEmptyString,
  isRecord,
  isUuid,
} from "@/lib/skillPublication/parse";

import { parseTemplateSkillSource } from "./skillSource";
import {
  TemplateError,
  TEMPLATE_ERROR_MESSAGE,
  type ImportReceipt,
  type ImportRequest,
  type RetainReceipt,
  type RetainRequest,
  type TemplateErrorCode,
} from "./types";

const BASE_PATH = "/v1/conductia/rail-templates";
const KEY_LIMIT = 100;
const UNREACHABLE = "The skill service did not answer, so nothing was saved.";
const UNCONFIGURED = "Skill retention is not configured on this environment.";
const MALFORMED = "The skill service returned a receipt Conductia cannot use.";

export async function retainTemplateSkills(
  revisionId: string,
  request: RetainRequest,
): Promise<RetainReceipt> {
  assertRetainRequest(revisionId, request);
  const body = await send(
    `${BASE_PATH}/revisions/${encodeURIComponent(revisionId)}/retain`,
    request,
  );
  const receipt = parseRetainReceipt(body);
  if (receipt === null || receipt.revisionId !== revisionId) {
    throw new TemplateError("provider_unavailable", MALFORMED, 502);
  }
  return receipt;
}

export async function importTemplateSkills(
  requestId: string,
  request: ImportRequest,
): Promise<ImportReceipt> {
  assertImportRequest(requestId, request);
  const body = await send(
    `${BASE_PATH}/imports/${encodeURIComponent(requestId)}`,
    request,
  );
  const receipt = parseImportReceipt(body);
  if (
    receipt === null ||
    receipt.requestId !== requestId ||
    receipt.projectId !== request.projectId
  ) {
    throw new TemplateError("provider_unavailable", MALFORMED, 502);
  }
  return receipt;
}

async function send(path: string, request: unknown): Promise<unknown> {
  const config = readSkillPublicationServiceConfig();
  if (config === null) {
    throw new TemplateError("provider_unavailable", UNCONFIGURED);
  }

  let response: Response;
  try {
    response = await fetch(`${config.benchUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${config.publicationToken}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(SKILL_PUBLICATION_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new TemplateError("provider_unavailable", UNREACHABLE);
  }

  const body = await readBody(response);
  if (!response.ok) throw failure(body);
  if (body === undefined) {
    throw new TemplateError("provider_unavailable", MALFORMED, 502);
  }
  return body;
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

function failure(body: unknown): TemplateError {
  if (
    !isRecord(body) ||
    typeof body.code !== "string" ||
    !Object.hasOwn(TEMPLATE_ERROR_MESSAGE, body.code)
  ) {
    return new TemplateError("provider_unavailable", UNREACHABLE);
  }
  const code = body.code as TemplateErrorCode;
  return new TemplateError(code, TEMPLATE_ERROR_MESSAGE[code]);
}

function parseRetainReceipt(body: unknown): RetainReceipt | null {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["revisionId", "assets"]) ||
    !isUuid(body.revisionId) ||
    !Array.isArray(body.assets)
  ) {
    return null;
  }
  const assets: RetainReceipt["assets"] = [];
  for (const asset of body.assets) {
    if (
      !isRecord(asset) ||
      !hasExactKeys(asset, ["key", "packageDigest"]) ||
      !isNonEmptyString(asset.key, KEY_LIMIT) ||
      !isDigest(asset.packageDigest)
    ) {
      return null;
    }
    assets.push({ key: asset.key, packageDigest: asset.packageDigest });
  }
  return uniqueKeys(assets) ? { revisionId: body.revisionId, assets } : null;
}

function parseImportReceipt(body: unknown): ImportReceipt | null {
  if (
    !isRecord(body) ||
    !hasExactKeys(body, ["requestId", "projectId", "skills"]) ||
    !isUuid(body.requestId) ||
    !isUuid(body.projectId) ||
    !Array.isArray(body.skills)
  ) {
    return null;
  }
  const skills: ImportReceipt["skills"] = [];
  for (const skill of body.skills) {
    if (
      !isRecord(skill) ||
      !hasExactKeys(skill, ["key", "binding"]) ||
      !isNonEmptyString(skill.key, KEY_LIMIT) ||
      !isRecord(skill.binding) ||
      !hasExactKeys(skill.binding, ["skillId", "versionId", "digest"]) ||
      !isUuid(skill.binding.skillId) ||
      !isUuid(skill.binding.versionId) ||
      !isDigest(skill.binding.digest)
    ) {
      return null;
    }
    skills.push({
      key: skill.key,
      binding: {
        skillId: skill.binding.skillId,
        versionId: skill.binding.versionId,
        digest: skill.binding.digest,
      },
    });
  }
  return uniqueKeys(skills)
    ? { requestId: body.requestId, projectId: body.projectId, skills }
    : null;
}

function uniqueKeys(entries: Array<{ key: string }>): boolean {
  return new Set(entries.map((entry) => entry.key)).size === entries.length;
}

function assertRetainRequest(revisionId: string, request: RetainRequest): void {
  const withProject = Object.hasOwn(request, "sourceProjectId");
  const valid =
    isUuid(revisionId) &&
    isUuid(request.companyId) &&
    (!withProject || isUuid(request.sourceProjectId)) &&
    hasExactKeys(
      request as unknown as Record<string, unknown>,
      withProject
        ? ["companyId", "sourceProjectId", "skills"]
        : ["companyId", "skills"],
    ) &&
    request.skills.every(
      (skill) =>
        isNonEmptyString(skill.key, KEY_LIMIT) &&
        parseTemplateSkillSource(skill.source) !== null,
    ) &&
    uniqueKeys(request.skills);
  if (!valid) {
    throw new TemplateError("invalid_command", MALFORMED);
  }
}

function assertImportRequest(requestId: string, request: ImportRequest): void {
  const valid =
    isUuid(requestId) &&
    isUuid(request.companyId) &&
    isUuid(request.revisionId) &&
    isUuid(request.projectId) &&
    hasExactKeys(request as unknown as Record<string, unknown>, [
      "companyId",
      "revisionId",
      "projectId",
      "targets",
    ]) &&
    request.targets.length > 0 &&
    request.targets.every(
      (target) =>
        isNonEmptyString(target.key, KEY_LIMIT) &&
        isUuid(target.operationId) &&
        isUuid(target.skillId) &&
        isUuid(target.versionId),
    ) &&
    (["key", "operationId", "skillId", "versionId"] as const).every(
      (field) =>
        new Set(request.targets.map((target) => target[field])).size ===
        request.targets.length,
    );
  if (!valid) {
    throw new TemplateError("invalid_command", MALFORMED);
  }
}
