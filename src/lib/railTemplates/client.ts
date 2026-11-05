import { isRecord } from "@/lib/skillPublication/parse";

import type {
  CreationResumeView,
  Gate0CreateReceipt,
  SaveRailCommand,
  TemplateErrorCode,
  TemplatePreview,
  TemplateSelection,
  TemplateSummary,
} from "./types";
import type { ValidatedGate0Input } from "@/lib/deals/createDealInput";

const TEMPLATES_PATH = "/api/v1/rail-templates";
const CREATIONS_PATH = "/api/v1/deals/template-creations";

const UNREACHABLE = "Conductia could not be reached. Try again.";
const UNREADABLE = "Conductia returned a rail template response it cannot use.";
const UNKNOWN = "This rail template request did not complete.";

export class RailTemplateRequestError extends Error {
  readonly status: number;
  readonly code: TemplateErrorCode | null;
  readonly retryable: boolean;

  constructor(
    status: number,
    message: string,
    code: TemplateErrorCode | null,
    retryable: boolean,
  ) {
    super(message);
    this.name = "RailTemplateRequestError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function requestInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    credentials: "include",
    headers:
      body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function failureOf(status: number, body: unknown): RailTemplateRequestError {
  const record = isRecord(body) ? body : {};
  const message = typeof record.error === "string" ? record.error : UNKNOWN;
  const code =
    typeof record.code === "string" ? (record.code as TemplateErrorCode) : null;
  const retryable =
    record.retryable === true || (code === null && status >= 500);
  return new RailTemplateRequestError(status, message, code, retryable);
}

async function call(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new RailTemplateRequestError(0, UNREACHABLE, null, true);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw failureOf(response.status, body);
  return body;
}

async function record(
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const body = await call(path, init);
  if (!isRecord(body)) {
    throw new RailTemplateRequestError(500, UNREADABLE, null, false);
  }
  return body;
}

export async function listRailTemplates(
  purpose?: "use" | "save",
): Promise<TemplateSummary[]> {
  const query = purpose === undefined ? "" : `?purpose=${purpose}`;
  const body = await record(`${TEMPLATES_PATH}${query}`, requestInit("GET"));
  return Array.isArray(body.templates)
    ? (body.templates as TemplateSummary[])
    : [];
}

export async function readRailTemplate(
  templateId: string,
): Promise<TemplatePreview> {
  return (await record(
    `${TEMPLATES_PATH}/${encodeURIComponent(templateId)}`,
    requestInit("GET"),
  )) as unknown as TemplatePreview;
}

export async function saveRail(
  command: SaveRailCommand,
): Promise<TemplateSummary> {
  const body = await call(TEMPLATES_PATH, requestInit("POST", command));
  if (!isRecord(body)) {
    throw new RailTemplateRequestError(500, UNREADABLE, null, true);
  }
  return body as unknown as TemplateSummary;
}

export async function readTemplateCreation(
  requestId: string,
): Promise<CreationResumeView> {
  const body = await record(
    `${CREATIONS_PATH}/${encodeURIComponent(requestId)}`,
    requestInit("GET"),
  );
  if (
    !isRecord(body.input) ||
    typeof body.input.codename !== "string" ||
    body.input.codename.length === 0 ||
    !isRecord(body.selection)
  ) {
    throw new RailTemplateRequestError(500, UNREADABLE, null, false);
  }
  return {
    requestId,
    input: body.input as unknown as ValidatedGate0Input,
    selection: body.selection as unknown as TemplateSelection,
    state: body.state === "ready" ? "ready" : "preparing",
  };
}

export async function resumeTemplateCreation(
  requestId: string,
): Promise<Gate0CreateReceipt> {
  return (await record(
    `${CREATIONS_PATH}/${encodeURIComponent(requestId)}`,
    requestInit("POST"),
  )) as unknown as Gate0CreateReceipt;
}
