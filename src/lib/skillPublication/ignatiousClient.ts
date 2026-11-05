import { isRecord } from "./parse";
import {
  parsePreparationResponse,
  parsePublicationLookup,
  parsePublicationReceipt,
} from "./parseService";
import {
  readSkillPublicationServiceConfig,
  SKILL_PUBLICATION_REQUEST_TIMEOUT_MS,
} from "./config";
import type {
  PrepareRequest,
  PreparationReceipt,
  PublishRequest,
  PublicationReceipt,
  PublicationLookup,
} from "./types";

export type SkillPublicationClientContext = {
  correlationId: string;
  fetchImpl?: typeof fetch;
};

export type SkillPublicationClientResult<T> =
  | { outcome: "success"; body: T }
  | { outcome: "unconfigured" }
  | { outcome: "timeout_or_network" }
  | { outcome: "http_error"; status: number; code: string | null }
  | { outcome: "invalid_response" };

type RequestOutcome =
  | { outcome: "timeout_or_network" }
  | { outcome: "http_error"; status: number; code: string | null }
  | { outcome: "invalid_response" }
  | { outcome: "parsed"; body: unknown };

function operationUrl(
  benchUrl: string,
  operationId: string,
  suffix: string,
): string {
  return `${benchUrl}/v1/conductia/skill-publications/${encodeURIComponent(operationId)}${suffix}`;
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) && typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

async function sendRequest(
  url: string,
  init: RequestInit,
  token: string,
  context: SkillPublicationClientContext,
): Promise<Response | null> {
  const fetchImpl = context.fetchImpl ?? fetch;
  try {
    return await fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "x-correlation-id": context.correlationId,
      },
      signal: AbortSignal.timeout(SKILL_PUBLICATION_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

async function readJsonBody(response: Response): Promise<RequestOutcome> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { outcome: "timeout_or_network" };
  }
  try {
    return { outcome: "parsed", body: JSON.parse(text) };
  } catch {
    return { outcome: "invalid_response" };
  }
}

async function performRequest(
  url: string,
  init: RequestInit,
  token: string,
  context: SkillPublicationClientContext,
): Promise<RequestOutcome> {
  const response = await sendRequest(url, init, token, context);
  if (response === null) return { outcome: "timeout_or_network" };
  if (!response.ok) {
    return {
      outcome: "http_error",
      status: response.status,
      code: await errorCode(response),
    };
  }
  return readJsonBody(response);
}

function postInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function prepare(
  operationId: string,
  body: PrepareRequest,
  context: SkillPublicationClientContext,
): Promise<SkillPublicationClientResult<PreparationReceipt>> {
  const config = readSkillPublicationServiceConfig();
  if (config === null) return { outcome: "unconfigured" };
  const outcome = await performRequest(
    operationUrl(config.benchUrl, operationId, "/prepare"),
    postInit(body),
    config.publicationToken,
    context,
  );
  if (outcome.outcome !== "parsed") return outcome;
  const parsed = parsePreparationResponse(outcome.body);
  return "error" in parsed
    ? { outcome: "invalid_response" }
    : { outcome: "success", body: parsed };
}

export async function publish(
  operationId: string,
  body: PublishRequest,
  context: SkillPublicationClientContext,
): Promise<SkillPublicationClientResult<PublicationReceipt>> {
  const config = readSkillPublicationServiceConfig();
  if (config === null) return { outcome: "unconfigured" };
  const outcome = await performRequest(
    operationUrl(config.benchUrl, operationId, "/publish"),
    postInit(body),
    config.publicationToken,
    context,
  );
  if (outcome.outcome !== "parsed") return outcome;
  const parsed = parsePublicationReceipt(outcome.body);
  return parsed === null
    ? { outcome: "invalid_response" }
    : { outcome: "success", body: parsed };
}

export async function lookup(
  operationId: string,
  context: SkillPublicationClientContext,
): Promise<SkillPublicationClientResult<PublicationLookup>> {
  const config = readSkillPublicationServiceConfig();
  if (config === null) return { outcome: "unconfigured" };
  const outcome = await performRequest(
    operationUrl(config.benchUrl, operationId, ""),
    { method: "GET" },
    config.publicationToken,
    context,
  );
  if (outcome.outcome !== "parsed") return outcome;
  const parsed = parsePublicationLookup(outcome.body);
  return "error" in parsed
    ? { outcome: "invalid_response" }
    : { outcome: "success", body: parsed };
}
